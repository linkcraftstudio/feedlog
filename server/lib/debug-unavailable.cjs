// Workers build: the bundled debug namespace has no default export, and
// probe-image-size calls it at load. Logging only, so a no-op is safe.
module.exports = () => () => {}
