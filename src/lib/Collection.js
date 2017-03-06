export default class Collection<T> {
    items: T[] = [];

    key: string = "id";

    findById(id: number) {
        return this.items.find(item => item[this.key] === id);
    }

    delete(item: T) {

    }
}