import { Repo } from "./repo";
import { User } from "./user";

function process() {
	const user = new User() as any;
	user.save();

	const repo = new Repo()!;
	repo.save();
}
