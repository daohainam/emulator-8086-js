NASM     = nasm
BIOS_SRC = bios.asm
BIOS_BIN = bios.bin

.PHONY: all clean

all: $(BIOS_BIN)

$(BIOS_BIN): $(BIOS_SRC)
	$(NASM) -f bin -o $@ $<

clean:
	rm -f $(BIOS_BIN)
