class IODevice {
    constructor(name) {
        this.name = name;
    }

    getPortRange() {
        return [];
    }

    onWrite(_port, _val, _bus) {
    }

    onRead(_port, _bus) {
        return undefined;
    }

    reset(_bus) {
    }
}

export { IODevice };
