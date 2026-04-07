class IODevice {
    constructor(name) {
        this.name = name;
    }

    getPortRange() {
        return [];
    }

    onWrite(_port, _val, _bus) {
    }

    reset(_bus) {
    }
}

export { IODevice };
