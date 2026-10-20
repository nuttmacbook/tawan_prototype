// Node 20's test runner reads each test file's stdout as its own message stream; a console.log
// from app code (the coach prints "🧑‍🏫 …") can land in the middle and fail the whole file with
// "Unable to deserialize cloned data". App logs go to stderr while testing.
console.log = (...args) => console.error(...args);
