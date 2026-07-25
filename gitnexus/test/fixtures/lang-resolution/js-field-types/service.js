const { User, Config } = require("./models");

function _processUser(user) {
	user.address.save();
}

function _validateConfig() {
	Config.DEFAULT.validate();
}
