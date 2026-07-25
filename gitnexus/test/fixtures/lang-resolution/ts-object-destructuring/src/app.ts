import { getUser } from "./service";

function _processDestructured() {
	const user = getUser();
	const { address } = user;
	address.save();
}

function _processMultiField() {
	const user = getUser();
	const { name, address } = user;
	address.save();
}
