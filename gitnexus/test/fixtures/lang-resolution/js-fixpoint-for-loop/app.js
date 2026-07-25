const { getUsers } = require("./models");

function _process() {
	const users = getUsers();
	for (const u of users) {
		u.save();
	}
}
