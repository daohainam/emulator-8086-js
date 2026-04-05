ORG 100h

    mov ax, 0xB800
	mov es, ax         ; ES points to Video RAM
	mov si, hello8086  ; SI points to source data
	mov di, 1990       ; DI points to center of screen (Row 12, Column 35)
	mov cx, 10         ; Loop 10 times (10 characters)

print_loop:
	lodsw              ; Load word from [SI] into AX, SI += 2
	mov [es:di], ax    ; Write directly to VGA screen
	add di, 2          ; Move to next screen cell
	loop print_loop
	hlt

hello8086:
	dw 0x0C48 ; 'H' (Light Red)
	dw 0x0E65 ; 'e' (Yellow)
	dw 0x0A6C ; 'l' (Light Green)
	dw 0x0B6C ; 'l' (Light Cyan)
	dw 0x096F ; 'o' (Light Blue)
	dw 0x0020 ; ' ' (Space)
	dw 0x0D38 ; '8' (Light Magenta)
	dw 0x0C30 ; '0' (Light Red)
	dw 0x0E38 ; '8' (Yellow)
	dw 0x0A36 ; '6' (Light Green)
