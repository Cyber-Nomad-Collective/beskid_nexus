import { Repo } from "./repo";
import { User } from "./user";

function process() {
	const user = new User() as unknown as any;
	user.save();

	const repo = new Repo() as unknown as object;
	repo.save();
}
