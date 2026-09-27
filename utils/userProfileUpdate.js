const { updateUser } = require('./compat/profile')

// Existing callers keep one entry point while transport and old aliases stay
// inside the temporary compatibility boundary.
module.exports = { callUpdateUser: updateUser }
