const { getUser } = require("./service");

function _processDestructured() {
	const user = getUser();
	const { address } = user;
	address.save();
}
