import { GrpcMethod } from "@nestjs/microservices";

export class AuthController {
	@GrpcMethod("AuthService", "Login")
	login(_data: unknown): unknown {
		return { token: "ok" };
	}
}
