import { getUser } from "./service";

function _processChain() {
	const user = getUser();
	const addr = user.address;
	const city = addr.getCity();
	city.save();
}
