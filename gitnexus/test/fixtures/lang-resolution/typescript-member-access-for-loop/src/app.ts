import type { Repo } from "./models/Repo";
import type { User } from "./models/User";

class UserService {
	processUsers(_users: User[]) {
		for (const user of this.users) {
			user.save();
		}
	}
}

class RepoService {
	processRepos(_repos: Repo[]) {
		for (const repo of this.repos) {
			repo.save();
		}
	}
}
