export class ControlCenterCommand {
    public static KILL_SERVER = 'kill_server';
    public static START_SERVER = 'start_server';
    public static UPDATE_INTERFACES = 'update_interfaces';
    public static CONFIGURE_STREAM = 'configure_stream';

    private id = -1;
    private type = '';
    private pid = 0;
    private udid = '';
    private data?: any;

    public static fromJSON(json: string): ControlCenterCommand {
        const body = JSON.parse(json);
        if (!body || typeof body !== 'object') {
            throw new Error('Invalid input');
        }
        const command = new ControlCenterCommand();
        const data = body.data;
        if (!data || typeof data !== 'object') {
            throw new Error('Invalid input: missing "data"');
        }
        command.data = data;
        command.id = body.id;
        command.type = body.type;

        if (typeof data.udid === 'string') {
            command.udid = data.udid;
        }
        switch (body.type) {
            case this.KILL_SERVER:
                if (typeof data.pid !== 'number' || data.pid <= 0) {
                    throw new Error('Invalid "pid" value');
                }
                command.pid = data.pid;
                return command;
            case this.START_SERVER:
            case this.UPDATE_INTERFACES:
            case this.CONFIGURE_STREAM:
                return command;
            default:
                throw new Error(`Unknown command "${body.command}"`);
        }
    }

    public getType(): string {
        return this.type;
    }
    public getPid(): number {
        return this.pid;
    }
    public getUdid(): string {
        return this.udid;
    }
    public getId(): number {
        return this.id;
    }
    public getData(): any {
        return this.data;
    }
}
