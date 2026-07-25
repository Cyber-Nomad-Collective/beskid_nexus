import type { User, UserService } from "./models";

function _processWithService(svc: UserService) {
	// call → field → call: svc.getUser().address.save()
	svc.getUser().address.save();
}

function _processWithUser(user: User) {
	// field → call → call: user.getAddress().city.getName()
	user.getAddress().city.getName();
}
