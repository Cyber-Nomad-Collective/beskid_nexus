import { ConsoleLogger } from "./logger";
import { BaseService, type ILogger } from "./models";

export class UserService extends BaseService implements ILogger {
	log(message: string): void {
		const logger = new ConsoleLogger();
		logger.log(message);
	}

	getUsers(): string[] {
		return [];
	}
}
