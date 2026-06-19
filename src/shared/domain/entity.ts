import { UniqueId } from './value-objects/unique-id.vo';

export abstract class Entity<T extends UniqueId = UniqueId> {
  constructor(protected readonly id: T) {}

  getId(): T {
    return this.id;
  }

  equals(other: Entity<T>): boolean {
    // check null or undefined
    if (other == null) {
      return false;
    }

    if (this === other) {
      return true;
    }

    return this.id.equals(other.id);
  }
}
