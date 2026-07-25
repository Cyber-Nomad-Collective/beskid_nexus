export {};

// Consumes AuthService gRPC
const _authClient = new AuthServiceClient("localhost:50051");

// Consumes user.logged-in topic
await consumer.subscribe({ topic: "user.logged-in", fromBeginning: true });
