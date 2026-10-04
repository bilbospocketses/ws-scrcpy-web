import type { Message } from '../types/Message';

export enum MessageType {
    HOSTS = 'hosts',
    ERROR = 'error',
}

export interface MessageHosts extends Message {
    type: 'hosts';
    data: {
        local?: { type: string }[];
    };
}

export interface MessageError extends Message {
    type: 'error';
    data: string;
}
