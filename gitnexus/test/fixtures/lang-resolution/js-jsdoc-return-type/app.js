const { User } = require("./user");
const { Repo } = require("./repo");

/**
 * @returns {User}
 */
function getUser(name) {
	return new User(name);
}

/**
 * @returns {Repo}
 */
function getRepo(path) {
	return new Repo(path);
}

function _processUser() {
	const user = getUser("alice");
	user.save();
}

function _processRepo() {
	const repo = getRepo("/data");
	repo.save();
}

/**
 * @param {User} user the user to handle
 */
function _handleUser(user) {
	user.save();
}

/**
 * @param {Repo} repo the repo to handle
 */
function _handleRepo(repo) {
	repo.save();
}
