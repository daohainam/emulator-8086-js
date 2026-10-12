// Device models: 8259 PIC, I/O bus, keyboard controller.
import { describe, it, expect } from 'vitest';
import { IOBus } from '../src/devices/IOBus.js';
import { PIC8259Device } from '../src/devices/PIC8259Device.js';
import { KeyboardDevice } from '../src/devices/KeyboardDevice.js';
import { SpeakerDevice } from '../src/devices/SpeakerDevice.js';

const picWith = (imr = 0x00) => { const p = new PIC8259Device(); p.imr = imr; return p; };

describe('8259 PIC', () => {
    it('delivers the highest-priority unmasked request with the programmed vector', () => {
        const pic = picWith(0x00);
        pic.raiseIRQ(3); pic.raiseIRQ(1);
        expect(pic.hasPendingInterrupt()).toBe(true);
        expect(pic.acknowledge()).toBe(0x09);          // IRQ1 beats IRQ3
        expect(pic.isr).toBe(0b10);
    });
    it('masked requests stay latched in IRR and fire when unmasked', () => {
        const pic = picWith(0xFF);
        pic.raiseIRQ(2);
        expect(pic.hasPendingInterrupt()).toBe(false);
        expect(pic.irr).toBe(0b100);
        pic.imr = 0x00;
        expect(pic.acknowledge()).toBe(0x0A);
    });
    it('blocks a request of the SAME level while it is in service, and lower priorities', () => {
        const pic = picWith(0x00);
        pic.pulseIRQ(1);
        expect(pic.acknowledge()).toBe(0x09);
        pic.pulseIRQ(1);                               // a second IRQ1 while the first is still in service
        pic.raiseIRQ(4);                               // lower priority
        expect(pic.hasPendingInterrupt()).toBe(false);
        expect(pic.acknowledge()).toBe(-1);
        pic.eoi();                                     // end of the first interrupt
        expect(pic.acknowledge()).toBe(0x09);          // the queued IRQ1 is now delivered
    });
    it('a higher priority request preempts a lower one in service', () => {
        const pic = picWith(0x00);
        pic.raiseIRQ(4);
        expect(pic.acknowledge()).toBe(0x0C);
        pic.raiseIRQ(1);
        expect(pic.hasPendingInterrupt()).toBe(true);
        expect(pic.acknowledge()).toBe(0x09);
    });
    it('edge-triggered sources fire once per pulse, not once per run', () => {
        const pic = picWith(0x00);
        const delivered = [];
        for (let i = 0; i < 3; i++) {
            pic.pulseIRQ(1);
            delivered.push(pic.acknowledge());
            pic.eoi();
        }
        expect(delivered).toEqual([0x09, 0x09, 0x09]);
    });
    it('without a falling edge the line stays high and later requests are missed (why pulseIRQ exists)', () => {
        const pic = picWith(0x00);
        pic.raiseIRQ(1); pic.acknowledge(); pic.eoi();
        pic.raiseIRQ(1);                               // line never went low
        expect(pic.hasPendingInterrupt()).toBe(false);
    });
    it('ICW sequence sets the vector offset and unmasks everything', () => {
        const pic = new PIC8259Device();
        pic.onWrite(0x20, 0x11);                       // ICW1: edge, cascade, ICW4 needed
        pic.onWrite(0x21, 0x70);                       // ICW2: vector base 0x70
        pic.onWrite(0x21, 0x04);                       // ICW3
        pic.onWrite(0x21, 0x01);                       // ICW4: 8086 mode
        expect(pic.vectorOffset).toBe(0x70);
        pic.raiseIRQ(5);
        expect(pic.acknowledge()).toBe(0x75);
    });
    it('OCW3 selects ISR / IRR readback and EOI via port 0x20', () => {
        const pic = picWith(0x00);
        pic.raiseIRQ(0); pic.acknowledge();
        pic.onWrite(0x20, 0x0B);                       // OCW3: read ISR
        expect(pic.onRead(0x20)).toBe(0x01);
        pic.onWrite(0x20, 0x20);                       // non-specific EOI
        expect(pic.onRead(0x20)).toBe(0x00);
    });
});

describe('I/O bus', () => {
    it('unclaimed ports read as 0xFF (floating bus), even after being written', () => {
        const bus = new IOBus();
        expect(bus.read(0x3DA)).toBe(0xFF);
        bus.write(0x3DA, 0x12);
        expect(bus.read(0x3DA)).toBe(0xFF);
    });
    it('a claimed port without a read handler reads back the last written value', () => {
        const bus = new IOBus();
        bus.register(new SpeakerDevice());
        bus.write(0x61, 0x03);
        expect(bus.read(0x61)).toBe(0x03);
    });
    it('word accesses are split into two byte accesses, low byte first', () => {
        const bus = new IOBus();
        const seen = [];
        bus.register({ getPortRange: () => [0x300, 0x301], onWrite: (p, v) => seen.push([p, v]), onRead: (p) => (p === 0x300 ? 0x34 : 0x12), reset() {} });
        bus.writeWord(0x300, 0xABCD);
        expect(seen).toEqual([[0x300, 0xCD], [0x301, 0xAB]]);
        expect(bus.readWord(0x300)).toBe(0x1234);
    });
    it('finds the PIC by its interface (not by constructor name)', () => {
        const bus = new IOBus();
        class Renamed extends PIC8259Device {}
        Object.defineProperty(Renamed, 'name', { value: 'a' }); // what a minifier does
        const pic = new Renamed();
        bus.register(pic);
        bus.raiseIRQ(2);
        expect(pic.irr).toBe(0b100);
    });
    it('reset clears the port latches and resets devices', () => {
        const bus = new IOBus();
        const pic = new PIC8259Device();
        bus.register(pic);
        pic.imr = 0; pic.raiseIRQ(1);
        bus.reset();
        expect([pic.imr, pic.irr]).toEqual([0xFF, 0]);
    });
});

describe('keyboard controller', () => {
    it('presents scan codes on port 0x60 in order, with the output-buffer flag on 0x64', () => {
        const kb = new KeyboardDevice();
        expect(kb.onRead(0x64) & 1).toBe(0);
        kb.pushScancode(0x23); kb.pushScancode(0xA3);   // H make, H break
        expect(kb.onRead(0x64) & 1).toBe(1);
        expect(kb.onRead(0x60)).toBe(0x23);
        expect(kb.onRead(0x64) & 1).toBe(1);
        expect(kb.onRead(0x60)).toBe(0xA3);
        expect(kb.onRead(0x64) & 1).toBe(0);
    });
    it('an empty controller keeps presenting the last byte', () => {
        const kb = new KeyboardDevice();
        kb.pushScancode(0x1E);
        kb.onRead(0x60);
        expect(kb.onRead(0x60)).toBe(0x1E);
    });
    it('is full after 16 scan codes', () => {
        const kb = new KeyboardDevice();
        for (let i = 0; i < 16; i++) expect(kb.pushScancode(i)).toBe(true);
        expect(kb.pushScancode(0x99)).toBe(false);
    });
    it('claims ports 0x60 and 0x64', () => {
        expect(new KeyboardDevice().getPortRange()).toEqual([0x60, 0x64]);
    });
});
