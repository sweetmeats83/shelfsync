--[[
ShelfSync
Tells a ShelfSync server which book a KOSync document hash belongs to
(Calibre UUID, ISBN, title, authors, filename). Progress itself is still sent
by KOReader's built-in Progress sync.

Reuses Progress sync's settings (custom server URL, username, password key,
document-matching method) so the hash sent here is the one Progress sync uses.
Everything is wrapped in pcall and uses short timeouts: it must never break reading.
]]

local DataStorage = require("datastorage")
local Device = require("device")
local InfoMessage = require("ui/widget/infomessage")
local LuaSettings = require("luasettings")
local NetworkMgr = require("ui/network/manager")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local logger = require("logger")
local md5 = require("ffi/sha2").md5
local util = require("util")
local _ = require("gettext")

local CHECKSUM_METHOD_FILENAME = 1 -- kosync: BINARY = 0, FILENAME = 1

local ShelfSync = WidgetContainer:extend{
    name = "shelfsync",
    is_doc_only = true,
}

function ShelfSync:init()
    self.cache = LuaSettings:open(DataStorage:getSettingsDir() .. "/shelfsync.lua")
    self.ui.menu:registerToMainMenu(self)
end

function ShelfSync:addToMainMenu(menu_items)
    menu_items.shelfsync = {
        text = _("ShelfSync"),
        sorting_hint = "tools",
        sub_item_table = {
            {
                text = _("Send this book now"),
                callback = function()
                    self:send(true)
                end,
            },
            {
                text_func = function()
                    local name = self.cache:readSetting("device_name")
                    return name and (_("Device name: ") .. name) or _("Name this device")
                end,
                callback = function(touchmenu_instance)
                    local InputDialog = require("ui/widget/inputdialog")
                    local dialog
                    dialog = InputDialog:new{
                        title = _("Device name in ShelfSync"),
                        input = self.cache:readSetting("device_name") or "",
                        input_hint = _("e.g. Living-room Kobo"),
                        buttons = {{
                            {
                                text = _("Cancel"),
                                callback = function() UIManager:close(dialog) end,
                            },
                            {
                                text = _("Save"),
                                is_enter_default = true,
                                callback = function()
                                    local name = dialog:getInputText():gsub("^%s+", ""):gsub("%s+$", "")
                                    UIManager:close(dialog)
                                    if name == "" then return end
                                    self.cache:saveSetting("device_name", name)
                                    self.cache:saveSetting("device_name_sent", false)
                                    self.cache:flush()
                                    if touchmenu_instance then touchmenu_instance:updateItems() end
                                    -- Needs an open book to send now; otherwise it goes with the next book you open.
                                    if self.ui.document then self:send(true) end
                                end,
                            },
                        }},
                    }
                    UIManager:show(dialog)
                    dialog:onShowKeyboard()
                end,
            },
            {
                text = _("Send highlights now"),
                callback = function()
                    self:sendHighlights(true)
                end,
            },
            {
                text = _("Send highlights automatically"),
                checked_func = function()
                    return self.cache:readSetting("auto_highlights") ~= false
                end,
                callback = function()
                    local on = self.cache:readSetting("auto_highlights") ~= false
                    self.cache:saveSetting("auto_highlights", not on)
                    self.cache:flush()
                end,
            },
            {
                text = _("Turn on Wi-Fi to send new highlights"),
                enabled_func = function()
                    return self.cache:readSetting("auto_highlights") ~= false
                end,
                checked_func = function()
                    return self.cache:readSetting("wifi_for_highlights") ~= false
                end,
                callback = function()
                    local on = self.cache:readSetting("wifi_for_highlights") ~= false
                    self.cache:saveSetting("wifi_for_highlights", not on)
                    self.cache:flush()
                end,
            },
            {
                text = _("Send automatically when a book opens"),
                checked_func = function()
                    return self.cache:readSetting("auto") ~= false
                end,
                callback = function()
                    local auto = self.cache:readSetting("auto") ~= false
                    self.cache:saveSetting("auto", not auto)
                    self.cache:flush()
                end,
            },
        },
    }
end

-- Prefer the running Progress sync plugin's live settings: it only flushes to
-- settings/kosync.lua occasionally, so a fresh login may not be on disk yet.
-- Fall back to the file (key "settings") if the plugin isn't loaded.
local function readKosyncSettings(ui)
    local live = ui and ui.kosync and ui.kosync.settings
    if type(live) == "table" and live.custom_server then
        return live
    end
    local f = LuaSettings:open(DataStorage:getSettingsDir() .. "/kosync.lua")
    return f:readSetting("settings") or {}
end

-- Same hash KOReader's Progress sync (kosync) uses for this book.
function ShelfSync:getDigest(kosync)
    local file = self.ui.document and self.ui.document.file
    if not file then return end
    if kosync.checksum_method == CHECKSUM_METHOD_FILENAME then
        local _path, name = util.splitFilePathName(file)
        return name and md5(name)
    end
    local digest = self.ui.doc_settings:readSetting("partial_md5_checksum")
    if not digest then
        digest = util.partialMD5(file)
    end
    return digest
end

-- Read the EPUB's OPF and pull out the Calibre UUID and an ISBN, if present.
-- ffi/archiver only knows an entry once iteration has passed it, so walk the
-- archive (it re-opens itself on each iterate()) and extract when we hit it.
local function readEntry(reader, wanted)
    for entry in reader:iterate() do
        local path = entry.path:gsub("^%./", "")
        if entry.mode == "file" and path == wanted then
            return reader:extractToMemory(entry.path)
        end
    end
end

-- Returns uuid, isbn, note. `note` explains a failure (shown on manual send).
local function readEpubIdentifiers(file)
    if not file:lower():match("%.epub$") then
        return nil, nil, "not an .epub file (" .. (file:match("%.(%w+)$") or "?") .. ")"
    end
    local Archiver = require("ffi/archiver")
    local reader = Archiver.Reader:new()
    if not reader:open(file) then return nil, nil, "couldn't open epub" end
    local uuids, isbn, note = {}, nil, nil
    local ok, err = pcall(function()
        local container = readEntry(reader, "META-INF/container.xml")
        local opf_path = container and container:match('full%-path%s*=%s*["\']([^"\']+)["\']')
        if not opf_path then note = "no container.xml/OPF path"; return end
        local opf = readEntry(reader, opf_path)
        if not opf then note = "couldn't read " .. opf_path; return end
        local seen = {}
        for attrs, value in opf:gmatch("<dc:identifier([^>]*)>(.-)</dc:identifier>") do
            seen[#seen + 1] = (attrs:gsub("%s+", " ")) .. " => " .. value:sub(1, 60)
            value = value:gsub("^%s+", ""):gsub("%s+$", "")
            local a = attrs:lower()
            local v = value:gsub("^urn:uuid:", ""):gsub("^urn:isbn:", "")
            -- Collect every UUID. Calibre's own id (scheme "calibre" / id calibre_id)
            -- goes first; the EPUB's separate uuid_id is only a fallback candidate.
            if v:match("^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$") then
                local u = v:lower()
                local dup = false
                for _i, existing in ipairs(uuids) do
                    if existing == u then dup = true end
                end
                if not dup then
                    if a:match('scheme%s*=%s*["\']calibre["\']') or a:match('id%s*=%s*["\']calibre_id["\']') then
                        table.insert(uuids, 1, u)
                    else
                        uuids[#uuids + 1] = u
                    end
                end
            end
            if not isbn then
                local digits = v:gsub("[%s%-]", "")
                if a:match('scheme%s*=%s*["\']isbn["\']') or value:lower():match("^urn:isbn:")
                        or digits:match("^97[89]%d%d%d%d%d%d%d%d%d%d$") then
                    if digits:match("^%d%d%d%d%d%d%d%d%d[%dXx]$") or digits:match("^%d%d%d%d%d%d%d%d%d%d%d%d%d$") then
                        isbn = digits
                    end
                end
            end
        end
        logger.info("ShelfSync: OPF identifiers:", #seen, table.concat(seen, " | "))
        if #uuids == 0 then
            note = #seen == 0 and "no dc:identifier in OPF" or ("no UUID among: " .. table.concat(seen, " | "))
        end
    end)
    reader:close()
    if not ok then
        logger.warn("ShelfSync: OPF parse failed", err)
        note = "OPF parse error: " .. tostring(err)
    end
    return uuids, isbn, note
end

function ShelfSync:getMetadata()
    local file = self.ui.document.file
    local _path, filename = util.splitFilePathName(file)
    local props = self.ui.doc_props or {}
    local title = props.title
    if not title or title == "" then
        title = props.display_title or filename:gsub("%.[^.]+$", "")
    end
    local authors
    if props.authors and props.authors ~= "" then
        -- KOReader separates multiple authors with newlines
        authors = {}
        for name in props.authors:gmatch("[^\n]+") do
            authors[#authors + 1] = name
        end
    end
    local uuids, isbn, note = readEpubIdentifiers(file)
    if #uuids == 0 then uuids = nil end
    return {
        title = title, authors = authors, filename = filename,
        calibre_uuid = uuids and uuids[1] or nil, -- best guess
        uuids = uuids,                            -- all candidates; server tries each
        isbn = isbn,
    }, note
end

local function request(url, body, headers)
    local ltn12 = require("ltn12")
    local socketutil = require("socketutil")
    local http = url:match("^https:") and require("ssl.https") or require("socket.http")
    local sink = {}
    socketutil:set_timeout(5, 10)
    local ok, code = http.request{
        url = url,
        method = "PUT",
        headers = headers,
        source = ltn12.source.string(body),
        sink = ltn12.sink.table(sink),
    }
    socketutil:reset_timeout()
    return ok, code, table.concat(sink)
end

function ShelfSync:send(manual)
    local function notify(msg)
        if manual then
            UIManager:show(InfoMessage:new{ text = msg, timeout = 5 })
        end
        logger.info("ShelfSync:", msg)
    end

    local kosync = readKosyncSettings(self.ui)
    if not kosync.custom_server or not kosync.username or not kosync.userkey then
        local missing = {}
        if not kosync.custom_server then missing[#missing + 1] = "server" end
        if not kosync.username then missing[#missing + 1] = "username" end
        if not kosync.userkey then missing[#missing + 1] = "login" end
        notify(_("Progress sync is missing: ") .. table.concat(missing, ", "))
        return
    end
    if not NetworkMgr:isOnline() then
        notify(_("Not online."))
        return
    end

    local digest = self:getDigest(kosync)
    if not digest then
        notify(_("Couldn't work out this book's sync hash."))
        return
    end

    local meta, id_note = self:getMetadata()
    -- A device name typed on this device is sent until the server has accepted it once.
    local pending_name = self.cache:readSetting("device_name_sent") == false and self.cache:readSetting("device_name") or nil
    local signature = table.concat({
        kosync.custom_server, digest, meta.title or "",
        meta.authors and table.concat(meta.authors, ";") or "",
        meta.uuids and table.concat(meta.uuids, ",") or "", meta.isbn or "",
        pending_name or "",
    }, "|")
    if not manual and self.cache:readSetting("sent_" .. digest) == signature then
        return -- already sent this exact info
    end

    meta.document = digest
    if pending_name then
        meta.device_name = pending_name
        meta.device_id = G_reader_settings:readSetting("device_id") or (self.ui.kosync and self.ui.kosync.device_id)
    end
    local JSON = require("json")
    local body = JSON.encode(meta)
    local url = kosync.custom_server:gsub("/+$", "") .. "/api/identify"
    local ok, code, resp = request(url, body, {
        ["Content-Type"] = "application/json",
        ["Accept"] = "application/json",
        ["Content-Length"] = tostring(#body),
        ["x-auth-user"] = kosync.username,
        ["x-auth-key"] = kosync.userkey,
    })

    if ok and type(code) == "number" and code >= 200 and code < 300 then
        self.cache:saveSetting("sent_" .. digest, signature)
        if pending_name and meta.device_id then self.cache:saveSetting("device_name_sent", true) end
        self.cache:flush()
        local parsed_ok, parsed = pcall(JSON.decode, resp)
        local message = parsed_ok and type(parsed) == "table" and parsed.message or nil
        message = message or (_("Sent to ShelfSync: ") .. (meta.title or meta.filename))
        if id_note then message = message .. "\n(" .. id_note .. ")" end
        notify(message)
    else
        logger.warn("ShelfSync: send failed", code, resp)
        notify(_("ShelfSync send failed: ") .. tostring(code))
    end
end

-- Highlights and notes ------------------------------------------------------

-- Newer KOReader keeps everything in ui.annotation.annotations (highlights, notes,
-- bookmarks); older versions keep highlights per page in the "highlight" setting.
-- Plain bookmarks have no text and are skipped.
function ShelfSync:getHighlights()
    local list = {}
    local doc = self.ui.document
    local total = doc and doc.getPageCount and tonumber(doc:getPageCount()) or nil
    local function add(a, page)
        local text = a.text
        if type(text) ~= "string" or text == "" then return end
        local pageno = tonumber(a.pageno) or tonumber(page)
        -- Reflowable books (EPUB) store a text position (xpointer) in `page`. A page number
        -- changes with font size, so work out where that position is in the current layout
        -- and send it as a percentage of the book, which means the same on every device.
        local xpointer = type(a.page) == "string" and a.page or nil
        if xpointer and doc and doc.getPageFromXPointer then
            local ok, p = pcall(doc.getPageFromXPointer, doc, xpointer)
            if ok and tonumber(p) then pageno = tonumber(p) end
        end
        local pct = (pageno and total and total > 0) and math.min(1, pageno / total) or nil
        list[#list + 1] = {
            text = text,
            note = type(a.note) == "string" and a.note ~= "" and a.note or nil,
            chapter = a.chapter,
            page = pageno,
            pct = pct,
            xpointer = xpointer,
            color = a.color,
            datetime = a.datetime,
        }
    end

    local annotations = self.ui.annotation and self.ui.annotation.annotations
    if type(annotations) == "table" then
        for _i, a in ipairs(annotations) do add(a) end
    elseif self.ui.doc_settings then
        local per_page = self.ui.doc_settings:readSetting("highlight")
        if type(per_page) == "table" then
            for page, items in pairs(per_page) do
                if type(items) == "table" then
                    for _i, a in ipairs(items) do add(a, page) end
                end
            end
        end
    end
    return list
end

function ShelfSync:sendHighlights(manual)
    local function notify(msg)
        if manual then
            UIManager:show(InfoMessage:new{ text = msg, timeout = 5 })
        end
        logger.info("ShelfSync highlights:", msg)
    end

    local kosync = readKosyncSettings(self.ui)
    if not kosync.custom_server or not kosync.username or not kosync.userkey then
        notify(_("Progress sync is not set up."))
        return
    end
    if not NetworkMgr:isOnline() then
        notify(_("Not online."))
        return
    end
    local digest = self:getDigest(kosync)
    if not digest then return end

    local highlights = self:getHighlights()
    if #highlights == 0 then
        self.cache:delSetting("hl_unsent_" .. digest)
        notify(_("No highlights in this book."))
        return
    end

    -- Skip the upload when nothing changed since the last successful send.
    local parts = {}
    for _i, h in ipairs(highlights) do
        parts[#parts + 1] = (h.datetime or "") .. (h.text or "") .. (h.note or "") .. (h.chapter or "")
    end
    local signature = md5(table.concat(parts, "\n"))
    if not manual and self.cache:readSetting("hl_" .. digest) == signature then
        self.cache:delSetting("hl_unsent_" .. digest)
        return
    end

    local page_total = self.ui.document and self.ui.document.getPageCount and self.ui.document:getPageCount() or nil
    local JSON = require("json")
    local body = JSON.encode({ document = digest, highlights = highlights, page_total = page_total })
    local url = kosync.custom_server:gsub("/+$", "") .. "/api/highlights"
    local ok, code, resp = request(url, body, {
        ["Content-Type"] = "application/json",
        ["Accept"] = "application/json",
        ["Content-Length"] = tostring(#body),
        ["x-auth-user"] = kosync.username,
        ["x-auth-key"] = kosync.userkey,
    })
    if ok and type(code) == "number" and code >= 200 and code < 300 then
        self.cache:saveSetting("hl_" .. digest, signature)
        self.cache:delSetting("hl_unsent_" .. digest)
        self.cache:flush()
        local parsed_ok, parsed = pcall(JSON.decode, resp)
        notify(parsed_ok and type(parsed) == "table" and parsed.message
            or (_("Sent highlights to ShelfSync: ") .. #highlights))
    else
        logger.warn("ShelfSync: highlight send failed", code, resp)
        notify(_("ShelfSync highlights failed: ") .. tostring(code))
    end
end

-- Seconds to wait after a highlight/note change, so a burst of edits goes in one upload.
local HIGHLIGHT_DELAY = 20

local function safeSend(self)
    local ok, err = pcall(self.sendHighlights, self, false)
    if not ok then logger.warn("ShelfSync highlights error:", err) end
end

function ShelfSync:onReaderReady()
    if self.cache:readSetting("auto") == false then return end
    -- Small delay so opening the book isn't slowed down.
    UIManager:scheduleIn(3, function()
        local ok, err = pcall(self.send, self, false)
        if not ok then logger.warn("ShelfSync error:", err) end
    end)
    if self.cache:readSetting("auto_highlights") ~= false then
        UIManager:scheduleIn(10, function()
            local digest = self:getDigest(readKosyncSettings(self.ui))
            if digest and self.cache:readSetting("hl_unsent_" .. digest) then
                self:sendHighlightsWhenOnline() -- changes left over from last time: worth turning Wi-Fi on
            elseif NetworkMgr:isOnline() then
                safeSend(self)
            end
        end)
    end
end

-- Send now if online; otherwise remember it, and turn Wi-Fi on if allowed (KOReader's
-- own "Action when Wi-Fi is off" setting decides whether that is silent or asks first).
function ShelfSync:sendHighlightsWhenOnline()
    if not self.ui.document then return end
    if NetworkMgr:isOnline() then
        self.hl_pending = false
        safeSend(self)
        return
    end
    self.hl_pending = true
    local digest = self:getDigest(readKosyncSettings(self.ui))
    if digest then
        self.cache:saveSetting("hl_unsent_" .. digest, true)
        self.cache:flush()
    end
    if self.cache:readSetting("wifi_for_highlights") ~= false and Device:hasWifiToggle() then
        NetworkMgr:runWhenOnline(function()
            if self.hl_pending and self.ui.document then
                self.hl_pending = false
                safeSend(self)
            end
        end)
    end
end

function ShelfSync:scheduleHighlightSend()
    if self.cache:readSetting("auto_highlights") == false then return end
    if self.hl_task then UIManager:unschedule(self.hl_task) end
    self.hl_task = function()
        self.hl_task = nil
        self:sendHighlightsWhenOnline()
    end
    UIManager:scheduleIn(HIGHLIGHT_DELAY, self.hl_task)
end

-- Fired by KOReader whenever a highlight or note is added, edited or removed.
function ShelfSync:onAnnotationsModified()
    self:scheduleHighlightSend()
end

-- Wi-Fi came up (by you or by another plugin): send anything that was waiting.
function ShelfSync:onNetworkConnected()
    if self.hl_pending then
        UIManager:scheduleIn(3, function() self:sendHighlightsWhenOnline() end)
    end
end

-- Closing a book: send now rather than wait, while the book is still open.
function ShelfSync:onCloseDocument()
    if self.hl_task then
        UIManager:unschedule(self.hl_task)
        self.hl_task = nil
    end
    if self.cache:readSetting("auto_highlights") == false then return end
    if NetworkMgr:isOnline() then safeSend(self) end
end

return ShelfSync
