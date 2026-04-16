NASM     = nasm
BIOS_SRC = bios.asm
BIOS_BIN = bios.bin

.PHONY: all clean

all: $(BIOS_BIN)

$(BIOS_BIN): $(BIOS_SRC) int16.asm
	$(NASM) -f bin -o $@ $<

clean:
	rm -f $(BIOS_BIN)
