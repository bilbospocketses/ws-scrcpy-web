import { Stats } from './Stats';

export class Entry extends Stats {
    constructor(
        public name: string,
        mode: number,
        size: number,
        mtime: number,
    ) {
        super(mode, size, mtime);
    }

    public override toString(): string {
        return this.name;
    }
}
