local _ = require("gettext")
return {
    name = "shelfsync",
    fullname = _("ShelfSync"),
    description = _([[Tells your ShelfSync server which book you opened (Calibre UUID, ISBN, title, author) so it can match the book to Hardcover. Uses the server and login from Progress sync.]]),
}
