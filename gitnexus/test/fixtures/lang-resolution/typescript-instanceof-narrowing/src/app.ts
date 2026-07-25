import { User } from "./user";

function _process(x) {
	if (x instanceof User) {
		x.save();
	}
}
