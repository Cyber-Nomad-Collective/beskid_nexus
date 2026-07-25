const { User } = require("./user");

/**
 * @returns {Promise<models.User>}
 */
async function fetchUser(name) {
	return new User(name);
}

async function _processUser() {
	const user = await fetchUser("alice");
	user.save();
}
