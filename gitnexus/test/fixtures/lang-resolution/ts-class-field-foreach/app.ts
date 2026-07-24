import type { Repo } from "./models/repo";
import type { User } from "./models/user";

class UserService {
	private users: User[] = [];
	private repos: Map<string, Repo> = new Map();

	processUsers() {
		for (const user of this.users) {
			user.save();
		}
	}

	processRepos() {
		for (const repo of this.repos.values()) {
			repo.save();
		}
	}
}
