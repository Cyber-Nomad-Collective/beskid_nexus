import type { User } from "./models";

function _processStrict(x: User | null) {
	if (x !== null) {
		x.save();
	}
}

function _processLoose(x: User | null) {
	if (x != null) {
		x.save();
	}
}

function _processUndefined(x: User | undefined) {
	if (x !== undefined) {
		x.save();
	}
}

const _processFuncExpr = (x: User | null) => {
	if (x !== null) {
		x.save();
	}
};
