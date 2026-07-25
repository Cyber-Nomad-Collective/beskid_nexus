const { getUser } = require("./service");

function _processUser() {
	const user = getUser("alice");
	user.save();
}
