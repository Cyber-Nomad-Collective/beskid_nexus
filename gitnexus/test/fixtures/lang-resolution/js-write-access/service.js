const { User, Address } = require("./models");

function _updateUser() {
	const user = new User();
	user.name = "Alice";
	user.address = new Address();
}
