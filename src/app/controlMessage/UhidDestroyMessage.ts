// src/app/controlMessage/UhidDestroyMessage.ts
import { BinaryWriter } from '../BinaryWriter';
import { ControlMessage } from './ControlMessage';

export class UhidDestroyMessage extends ControlMessage {
    constructor(private readonly id: number) {
        super(ControlMessage.TYPE_UHID_DESTROY);
    }

    public toUint8Array(): Uint8Array {
        return new BinaryWriter(3)
            .writeUInt8(this.type)
            .writeUInt16BE(this.id)
            .toUint8Array();
    }
}
