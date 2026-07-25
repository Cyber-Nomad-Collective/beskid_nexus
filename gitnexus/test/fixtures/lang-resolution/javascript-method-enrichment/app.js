const { Animal, Dog } = require("./animal");

const dog = new Dog();
const _sound = dog.speak();
const _category = Animal.classify("dog");
