; =============================================================================
; 8086 Emulator BIOS Extension ROM
; Loaded at 0xC000:0x0000
;
; Provides handlers for:
;   INT 0x10 - Video Services (cursor control via CRT Controller I/O ports)
;   INT 0x13 - Disk Services (stub)
;   INT 0x16 - Keyboard Services (stub)
;
; INT 0x10 subfunctions implemented:
;   AH=0x01 – Set Cursor Shape (programs CRT ports 0x3D4/0x3D5, updates BDA)
;   AH=0x02 – Set Cursor Position (programs CRT ports 0x3D4/0x3D5, updates BDA)
;   AH=0x03 – Get Cursor Position and Shape (reads from BDA)
;   AH=0x06 – Scroll Window Up
;   AH=0x07 – Scroll Window Down
;   AH=0x08 – Read Character and Attribute at Cursor
;   AH=0x09 – Write Character and Attribute at Cursor
;   AH=0x0A – Write Character Only at Cursor
;   AH=0x0E – Teletype Output
;   AH=0x0F – Get Current Video Mode
;   AH=0x13 – Write String
;
; A common handler is installed for all other interrupts; it writes an error
; message to the top-left corner of the video screen, sets AX=1, and returns.
; =============================================================================

[bits 16]
[org 0]

ROM_SEG  equ 0xC000         ; Segment where this ROM is loaded
ROM_SIZE equ 8192           ; 8 KB = 16 * 512 bytes

; =============================================================================
; ROM Header (required for BIOS extension ROM detection by POST)
; =============================================================================
db 0x55                     ; Signature byte 1
db 0xAA                     ; Signature byte 2
db (ROM_SIZE / 512)         ; Size in 512-byte blocks (0x10 = 16 blocks = 8 KB)

; POST performs a far call to 0xC000:0003, so the init entry must be here.
jmp near init

; =============================================================================
; Constants
; =============================================================================
CRT_INDEX   equ 0x3D4           ; CRT Controller index port
CRT_DATA    equ 0x3D5           ; CRT Controller data port
CRT_CURSOR_HIGH equ 0x0E        ; Cursor location high-byte register index
CRT_CURSOR_LOW  equ 0x0F        ; Cursor location low-byte register index
CRT_CURSOR_START equ 0x0A       ; Cursor start scan line register index
CRT_CURSOR_END   equ 0x0B       ; Cursor end scan line register index

TEXT_COLS   equ 80              ; Text mode columns per row
TEXT_ROWS   equ 25              ; Text mode rows
VIDEO_SEG   equ 0xB800          ; CGA text mode video memory segment
PAGE_SIZE   equ 4096            ; Bytes per display page (standard CGA)

; BIOS Data Area (BDA) offsets (segment 0x0040)
BDA_VIDEO_MODE   equ 0x49       ; Byte: current video mode
BDA_NUM_COLS     equ 0x4A       ; Word: number of text columns
BDA_PAGE_SIZE    equ 0x4C       ; Word: page size in bytes
BDA_CURSOR_POS   equ 0x50       ; 8 words (one per page): low=column, high=row
BDA_CURSOR_SHAPE equ 0x60       ; Word: low=end scan line, high=start scan line
BDA_ACTIVE_PAGE  equ 0x62       ; Byte: active display page number

; Default cursor shape for CGA 80x25 text mode (scan lines 6–7)
DEFAULT_CURSOR_START equ 0x06
DEFAULT_CURSOR_END   equ 0x07

; =============================================================================
; Data
; =============================================================================
err_msg  db 'Unhandled interrupt!', 0

; =============================================================================
; Initialization routine
; Called by POST via far call to 0xC000:0003.
; Installs INT 0x10, 0x13, and 0x16 vectors, then returns far.
; =============================================================================
init:
    push ax
    push bx
    push cx
    push es

    xor ax, ax
    mov es, ax              ; ES = 0 (IVT segment)

    ; Install common_handler for all 256 interrupt vectors
    xor bx, bx              ; BX = IVT byte offset (starts at 0)
    mov cx, 256
.ivt_loop:
    mov word [es:bx],     common_handler
    mov word [es:bx + 2], ROM_SEG
    add bx, 4
    loop .ivt_loop

    ; Override with specific handlers for INT 0x10, 0x13, 0x16

    ; Install INT 0x10 (Video Services) handler
    mov word [es:0x10 * 4],     int10_handler
    mov word [es:0x10 * 4 + 2], ROM_SEG

    ; Install INT 0x13 (Disk Services) handler
    mov word [es:0x13 * 4],     int13_handler
    mov word [es:0x13 * 4 + 2], ROM_SEG

    ; Install INT 0x16 (Keyboard Services) handler
    mov word [es:0x16 * 4],     int16_handler
    mov word [es:0x16 * 4 + 2], ROM_SEG

    ; -------------------------------------------------------------------------
    ; Initialise BIOS Data Area (BDA) cursor state and program hardware cursor
    ; -------------------------------------------------------------------------
    push dx

    ; Point ES to BDA segment
    mov ax, 0x0040
    mov es, ax

    ; Set video mode = 3 (80x25 color text)
    mov byte [es:BDA_VIDEO_MODE], 0x03

    ; Set number of columns = 80
    mov word [es:BDA_NUM_COLS], TEXT_COLS

    ; Set page size
    mov word [es:BDA_PAGE_SIZE], PAGE_SIZE

    ; Set active display page = 0
    mov byte [es:BDA_ACTIVE_PAGE], 0

    ; Set default cursor shape: start=6, end=7 (CGA-style 80×25 text mode)
    ; Stored as word: low byte = end (CL), high byte = start (CH)
    mov word [es:BDA_CURSOR_SHAPE], (DEFAULT_CURSOR_START << 8) | DEFAULT_CURSOR_END

    ; Zero cursor positions for all 8 pages (offsets 0x50 – 0x5F)
    xor ax, ax
    mov bx, BDA_CURSOR_POS
    mov cx, 8
.clear_cursor_loop:
    mov word [es:bx], ax
    add bx, 2
    loop .clear_cursor_loop

    ; Program CRT cursor start scan line register (0x0A)
    mov dx, CRT_INDEX
    mov al, CRT_CURSOR_START
    out dx, al
    mov dx, CRT_DATA
    mov al, DEFAULT_CURSOR_START
    out dx, al

    ; Program CRT cursor end scan line register (0x0B)
    mov dx, CRT_INDEX
    mov al, CRT_CURSOR_END
    out dx, al
    mov dx, CRT_DATA
    mov al, DEFAULT_CURSOR_END
    out dx, al

    ; Program CRT cursor position to linear offset 0 (row 0, column 0)
    mov dx, CRT_INDEX
    mov al, CRT_CURSOR_HIGH
    out dx, al
    mov dx, CRT_DATA
    xor al, al
    out dx, al

    mov dx, CRT_INDEX
    mov al, CRT_CURSOR_LOW
    out dx, al
    mov dx, CRT_DATA
    xor al, al
    out dx, al

    pop dx
    pop es
    pop cx
    pop bx
    pop ax
    retf                    ; Return far to POST

; =============================================================================
; INT 0x10 - Video Services
; Dispatches on AH to the appropriate subfunction.
; =============================================================================
int10_handler:
    cmp ah, 0x01
    je  .set_cursor_type
    cmp ah, 0x02
    je  .set_cursor_pos
    cmp ah, 0x03
    je  .get_cursor_pos
    cmp ah, 0x06
    je  .jmp_scroll_up
    cmp ah, 0x07
    je  .jmp_scroll_down
    cmp ah, 0x08
    je  .jmp_read_char_attr
    cmp ah, 0x09
    je  .jmp_write_char_attr
    cmp ah, 0x0A
    je  .jmp_write_char_only
    cmp ah, 0x0E
    je  .jmp_teletype
    cmp ah, 0x0F
    je  .jmp_get_video_mode
    cmp ah, 0x13
    je  .jmp_write_string

    ; Unknown subfunction
    mov ax, 0x0001
    stc
    iret

; Trampolines for handlers beyond short-jump range
.jmp_scroll_up:      jmp .scroll_up
.jmp_scroll_down:    jmp .scroll_down
.jmp_read_char_attr: jmp .read_char_attr
.jmp_write_char_attr: jmp .write_char_attr
.jmp_write_char_only: jmp .write_char_only
.jmp_teletype:       jmp .teletype_output
.jmp_get_video_mode: jmp .get_video_mode
.jmp_write_string:   jmp .write_string

; ---------------------------------------------------------------------------
; AH=0x01 – Set Cursor Shape
;   In:  CH = cursor start scan line (bit 5 = disable cursor)
;        CL = cursor end scan line
;   Out: (nothing)
; ---------------------------------------------------------------------------
.set_cursor_type:
    push ax
    push cx
    push dx
    push ds

    ; Save cursor shape in BDA[0x60]: low byte = end (CL), high byte = start (CH)
    mov ax, 0x0040
    mov ds, ax
    mov word [BDA_CURSOR_SHAPE], cx

    ; Program CRT cursor start scan line (index CRT_CURSOR_START = 0x0A)
    mov dx, CRT_INDEX
    mov al, CRT_CURSOR_START
    out dx, al
    mov dx, CRT_DATA
    mov al, ch
    out dx, al

    ; Program CRT cursor end scan line (index CRT_CURSOR_END = 0x0B)
    mov dx, CRT_INDEX
    mov al, CRT_CURSOR_END
    out dx, al
    mov dx, CRT_DATA
    mov al, cl
    out dx, al

    pop ds
    pop dx
    pop cx
    pop ax
    clc
    iret

; ---------------------------------------------------------------------------
; AH=0x02 – Set Cursor Position
;   In:  BH = page number
;        DH = row  (0-based)
;        DL = column (0-based)
;   Out: (nothing)
; ---------------------------------------------------------------------------
.set_cursor_pos:
    push ax
    push bx
    push cx
    push dx
    push ds

    mov cl, bh              ; CL = page number (free BH for other use)

    ; Store position in BDA: word at [0x50 + page*2], low=col, high=row
    mov ax, 0x0040
    mov ds, ax
    xor bh, bh
    mov bl, cl
    shl bx, 1               ; BX = page * 2
    add bx, BDA_CURSOR_POS  ; BX = BDA offset for this page
    mov word [bx], dx       ; DL=col → low byte, DH=row → high byte

    ; Update hardware cursor only when the requested page is the active page
    mov al, byte [BDA_ACTIVE_PAGE]
    cmp al, cl
    jne .skip_hw_pos

    ; Linear cursor position = row * TEXT_COLS + column
    mov al, dh              ; AL = row
    mov bl, TEXT_COLS       ; BL = 80
    mul bl                  ; AX = row * 80
    xor bh, bh
    mov bl, dl              ; BL = column
    add ax, bx              ; AX = linear position

    ; Write high byte (index 0x0E)
    mov bx, ax              ; BX = linear position (BH = high, BL = low)
    mov dx, CRT_INDEX
    mov al, CRT_CURSOR_HIGH
    out dx, al
    mov dx, CRT_DATA
    mov al, bh
    out dx, al

    ; Write low byte (index 0x0F)
    mov dx, CRT_INDEX
    mov al, CRT_CURSOR_LOW
    out dx, al
    mov dx, CRT_DATA
    mov al, bl
    out dx, al

.skip_hw_pos:
    pop ds
    pop dx
    pop cx
    pop bx
    pop ax
    clc
    iret

; ---------------------------------------------------------------------------
; AH=0x03 – Get Cursor Position and Shape
;   In:  BH = page number
;   Out: CH = cursor start scan line
;        CL = cursor end scan line
;        DH = row
;        DL = column
; ---------------------------------------------------------------------------
.get_cursor_pos:
    push ax
    push bx
    push ds

    mov al, bh              ; AL = page number

    ; Point DS at BDA
    push ax                 ; preserve page number across segment load
    mov ax, 0x0040
    mov ds, ax
    pop ax                  ; AL = page number again

    ; Read cursor position for this page
    xor ah, ah              ; AX = page
    xor bh, bh
    mov bl, al              ; BX = page
    shl bx, 1               ; BX = page * 2
    add bx, BDA_CURSOR_POS  ; BX = BDA offset
    mov dx, word [bx]       ; DH = row, DL = column

    ; Read cursor shape
    mov cx, word [BDA_CURSOR_SHAPE]   ; CL = end, CH = start

    pop ds
    pop bx
    pop ax
    clc
    iret

; ---------------------------------------------------------------------------
; AH=0x06 – Scroll Window Up
;   In:  AL = lines to scroll (0 = clear entire window)
;        BH = attribute for blank area
;        CH = top row, CL = left column
;        DH = bottom row, DL = right column
;   Out: (nothing)
; ---------------------------------------------------------------------------
.scroll_up:
    push bp
    mov bp, sp
    sub sp, 8               ; Locals: [bp-2]=width, [bp-4]=fill word,
                             ;         [bp-6]=stride, [bp-8]=scroll count
    push ax
    push bx
    push cx
    push dx
    push si
    push di
    push ds
    push es

    mov [bp-8], al           ; Save scroll count
    mov byte [bp-4], 0x20    ; Fill character = space
    mov byte [bp-3], bh      ; Fill attribute

    ; Width = right_col - left_col + 1
    mov al, dl
    sub al, cl
    inc al
    xor ah, ah
    mov [bp-2], ax

    ; Stride = (TEXT_COLS - width) * 2
    push dx
    mov dl, TEXT_COLS
    sub dl, al
    xor dh, dh
    shl dx, 1
    mov [bp-6], dx
    pop dx

    ; Set video memory segments
    mov ax, VIDEO_SEG
    mov ds, ax
    mov es, ax
    cld

    ; Window height = bottom_row - top_row + 1
    mov al, dh
    sub al, ch
    inc al                   ; AL = window height

    mov ah, [bp-8]           ; AH = scroll count
    test ah, ah
    jz .su_clear
    cmp ah, al
    jae .su_clear

    ; ---- Copy phase: move rows up ----
    sub al, ah               ; AL = rows to copy

    ; Destination offset: (top_row * 80 + left_col) * 2
    push ax
    mov al, ch
    mov bl, TEXT_COLS
    mul bl
    xor bh, bh
    mov bl, cl
    add ax, bx
    shl ax, 1
    mov di, ax

    ; Source offset: ((top_row + scroll) * 80 + left_col) * 2
    mov al, ch
    add al, [bp-8]
    mov bl, TEXT_COLS
    mul bl
    xor bh, bh
    mov bl, cl
    add ax, bx
    shl ax, 1
    mov si, ax
    pop ax                   ; AL = rows to copy

    mov bx, [bp-6]          ; BX = stride adjustment

.su_copy_loop:
    test al, al
    jz .su_fill
    push ax
    mov cx, [bp-2]
    rep movsw
    add si, bx
    add di, bx
    pop ax
    dec al
    jmp .su_copy_loop

.su_fill:
    mov al, [bp-8]          ; AL = rows to fill
    mov bx, [bp-6]
.su_fill_loop:
    test al, al
    jz .su_done
    push ax
    mov cx, [bp-2]
    mov ax, [bp-4]           ; AX = fill word (space + attribute)
    rep stosw
    add di, bx
    pop ax
    dec al
    jmp .su_fill_loop

.su_clear:
    ; Clear entire window: set fill count = window height
    mov [bp-8], al
    push ax
    mov al, ch
    mov bl, TEXT_COLS
    mul bl
    xor bh, bh
    mov bl, cl
    add ax, bx
    shl ax, 1
    mov di, ax
    pop ax
    jmp .su_fill

.su_done:
    pop es
    pop ds
    pop di
    pop si
    pop dx
    pop cx
    pop bx
    pop ax
    add sp, 8
    pop bp
    clc
    iret

; ---------------------------------------------------------------------------
; AH=0x07 – Scroll Window Down
;   In:  AL = lines to scroll (0 = clear entire window)
;        BH = attribute for blank area
;        CH = top row, CL = left column
;        DH = bottom row, DL = right column
;   Out: (nothing)
; ---------------------------------------------------------------------------
.scroll_down:
    push bp
    mov bp, sp
    sub sp, 8               ; Same locals layout as scroll_up
    push ax
    push bx
    push cx
    push dx
    push si
    push di
    push ds
    push es

    mov [bp-8], al
    mov byte [bp-4], 0x20
    mov byte [bp-3], bh

    mov al, dl
    sub al, cl
    inc al
    xor ah, ah
    mov [bp-2], ax

    push dx
    mov dl, TEXT_COLS
    sub dl, al
    xor dh, dh
    shl dx, 1
    mov [bp-6], dx           ; Forward stride (used for clear)
    pop dx

    mov ax, VIDEO_SEG
    mov ds, ax
    mov es, ax
    cld

    mov al, dh
    sub al, ch
    inc al                   ; AL = window height

    mov ah, [bp-8]
    test ah, ah
    jz .sd_clear
    cmp ah, al
    jae .sd_clear

    ; ---- Copy phase: move rows down (bottom to top) ----
    sub al, ah               ; AL = rows to copy

    ; Destination: bottom row
    push ax
    mov al, dh
    mov bl, TEXT_COLS
    mul bl
    xor bh, bh
    mov bl, cl
    add ax, bx
    shl ax, 1
    mov di, ax

    ; Source: bottom_row - scroll_count
    mov al, dh
    sub al, [bp-8]
    mov bl, TEXT_COLS
    mul bl
    xor bh, bh
    mov bl, cl
    add ax, bx
    shl ax, 1
    mov si, ax
    pop ax                   ; AL = rows to copy

    ; Backward stride = (width + TEXT_COLS) * 2
    push dx
    mov dx, [bp-2]
    add dx, TEXT_COLS
    shl dx, 1
    mov bx, dx
    pop dx

.sd_copy_loop:
    test al, al
    jz .sd_fill
    push ax
    mov cx, [bp-2]
    rep movsw
    sub si, bx
    sub di, bx
    pop ax
    dec al
    jmp .sd_copy_loop

.sd_fill:
    mov al, [bp-8]          ; AL = rows to fill
.sd_fill_loop:
    test al, al
    jz .sd_done
    push ax
    mov cx, [bp-2]
    mov ax, [bp-4]
    rep stosw
    sub di, bx
    pop ax
    dec al
    jmp .sd_fill_loop

.sd_clear:
    ; Clear entire window (top to bottom, reuse scroll_up fill logic)
    mov [bp-8], al
    push ax
    mov al, ch
    mov bl, TEXT_COLS
    mul bl
    xor bh, bh
    mov bl, cl
    add ax, bx
    shl ax, 1
    mov di, ax
    pop ax
    jmp .su_fill             ; Shared fill loop (identical stack layout)

.sd_done:
    pop es
    pop ds
    pop di
    pop si
    pop dx
    pop cx
    pop bx
    pop ax
    add sp, 8
    pop bp
    clc
    iret

; ---------------------------------------------------------------------------
; AH=0x08 – Read Character and Attribute at Cursor
;   In:  BH = page number
;   Out: AL = character, AH = attribute
; ---------------------------------------------------------------------------
.read_char_attr:
    push bx
    push cx
    push dx
    push di
    push ds
    push es

    mov ax, 0x0040
    mov ds, ax
    call _get_cursor_bda     ; DH=row, DL=col
    call _cursor_to_vram_di  ; DI = (row*80+col)*2

    ; Add page offset: page * PAGE_SIZE (4096 = 2^12)
    mov al, bh
    xor ah, ah
    mov cl, 12
    shl ax, cl
    add di, ax

    mov ax, VIDEO_SEG
    mov es, ax
    mov ax, word [es:di]     ; AL=character, AH=attribute

    pop es
    pop ds
    pop di
    pop dx
    pop cx
    pop bx
    clc
    iret

; ---------------------------------------------------------------------------
; AH=0x09 – Write Character and Attribute at Cursor
;   In:  AL = character, BH = page, BL = attribute, CX = count
;   Out: (nothing)
; ---------------------------------------------------------------------------
.write_char_attr:
    push ax
    push bx
    push cx
    push dx
    push di
    push ds
    push es

    mov ah, bl               ; AH = attribute (AL already has character)
    push ax                  ; Save char+attr word

    mov ax, 0x0040
    mov ds, ax
    call _get_cursor_bda     ; DH=row, DL=col
    call _cursor_to_vram_di  ; DI = (row*80+col)*2

    ; Add page offset
    mov al, bh
    xor ah, ah
    push cx
    mov cl, 12
    shl ax, cl
    pop cx
    add di, ax

    mov ax, VIDEO_SEG
    mov es, ax

    pop ax                   ; AX = char(AL) + attr(AH)
    cld
    jcxz .wca_done
    rep stosw

.wca_done:
    pop es
    pop ds
    pop di
    pop dx
    pop cx
    pop bx
    pop ax
    clc
    iret

; ---------------------------------------------------------------------------
; AH=0x0A – Write Character Only at Cursor
;   In:  AL = character, BH = page, CX = count
;   Out: (nothing)
; ---------------------------------------------------------------------------
.write_char_only:
    push ax
    push bx
    push cx
    push dx
    push di
    push ds
    push es

    push ax                  ; Save character (in AL)

    mov ax, 0x0040
    mov ds, ax
    call _get_cursor_bda     ; DH=row, DL=col
    call _cursor_to_vram_di  ; DI = (row*80+col)*2

    ; Add page offset
    mov al, bh
    xor ah, ah
    push cx
    mov cl, 12
    shl ax, cl
    pop cx
    add di, ax

    mov ax, VIDEO_SEG
    mov es, ax

    pop ax                   ; AL = character

    jcxz .wco_done
.wco_loop:
    mov byte [es:di], al     ; Write character only (preserve attribute)
    add di, 2
    loop .wco_loop
.wco_done:
    pop es
    pop ds
    pop di
    pop dx
    pop cx
    pop bx
    pop ax
    clc
    iret

; ---------------------------------------------------------------------------
; AH=0x0E – Teletype Output
;   In:  AL = character, BH = page number
;   Out: (nothing)
;   Writes character at cursor, advances cursor, handles CR/LF/BS/BEL,
;   scrolls screen when cursor moves past the last row.
; ---------------------------------------------------------------------------
.teletype_output:
    push ax
    push bx
    push cx
    push dx
    push di
    push ds
    push es

    mov cl, al               ; CL = character to output
    mov ch, bh               ; CH = page number (save for later)

    mov ax, 0x0040
    mov ds, ax
    call _get_cursor_bda     ; DH=row, DL=col

    ; Handle special characters
    cmp cl, 0x07
    je .tty_done              ; BEL: ignore
    cmp cl, 0x08
    je .tty_bs
    cmp cl, 0x0A
    je .tty_lf
    cmp cl, 0x0D
    je .tty_cr

    ; Normal character: write to VRAM (preserve existing attribute)
    push dx
    call _cursor_to_vram_di   ; DI = offset

    ; Add page offset
    mov al, ch
    xor ah, ah
    push cx
    mov cl, 12
    shl ax, cl
    pop cx
    add di, ax

    mov ax, VIDEO_SEG
    mov es, ax
    mov byte [es:di], cl      ; Write character only
    pop dx

    ; Advance cursor
    inc dl
    cmp dl, TEXT_COLS
    jb .tty_set_cursor
    xor dl, dl                ; Wrap to column 0
    inc dh                    ; Next row
    jmp .tty_check_scroll

.tty_bs:
    cmp dl, 0
    je .tty_set_cursor        ; Already at column 0
    dec dl
    jmp .tty_set_cursor

.tty_lf:
    inc dh
    jmp .tty_check_scroll

.tty_cr:
    xor dl, dl
    jmp .tty_set_cursor

.tty_check_scroll:
    cmp dh, TEXT_ROWS
    jb .tty_set_cursor
    mov dh, TEXT_ROWS - 1     ; Stay at bottom row

    ; Scroll entire screen up by 1 line
    push dx
    push cx
    mov ax, VIDEO_SEG
    mov ds, ax
    mov es, ax
    cld
    mov ah, 0x07              ; Fill attribute: white on black
    call _scroll_up_fullscreen
    mov ax, 0x0040
    mov ds, ax
    pop cx
    pop dx

.tty_set_cursor:
    mov bl, ch                ; BL = page number
    call _set_cursor_bda_and_hw

.tty_done:
    pop es
    pop ds
    pop di
    pop dx
    pop cx
    pop bx
    pop ax
    clc
    iret

; ---------------------------------------------------------------------------
; AH=0x0F – Get Current Video Mode
;   Out: AL = video mode (3 = 80x25 color text)
;        AH = number of columns (80)
;        BH = active display page
; ---------------------------------------------------------------------------
.get_video_mode:
    push ds
    mov ax, 0x0040
    mov ds, ax
    mov ah, byte [BDA_NUM_COLS]       ; AH = 80
    mov al, byte [BDA_VIDEO_MODE]     ; AL = 3
    mov bh, byte [BDA_ACTIVE_PAGE]    ; BH = active page
    pop ds
    clc
    iret

; ---------------------------------------------------------------------------
; AH=0x13 – Write String
;   In:  AL = write mode (bit 0: update cursor, bit 1: string has attrs)
;        BH = page, BL = attribute (if mode bits 0–1)
;        CX = string length
;        DH = row, DL = column
;        ES:BP = pointer to string
;   Out: (nothing, or cursor updated per mode)
; ---------------------------------------------------------------------------
.write_string:
    push ax
    push bx
    push cx
    push dx
    push si
    push di
    push ds
    push es

    ; Capture caller's string pointer before modifying ES/BP
    mov si, bp                ; SI = string offset (caller's BP)

    ; Set up BP frame for local variables
    push bp
    mov bp, sp
    sub sp, 6                 ; [bp-2]=string segment, [bp-4]=mode, [bp-6]=attr

    ; Save locals (BP-relative addressing defaults to SS segment on 8086)
    mov byte [bp-4], al       ; Write mode
    mov byte [bp-6], bl       ; Default attribute

    mov ax, es
    mov [bp-2], ax            ; String segment (caller's ES)

    ; Save original cursor position for modes 0/2
    push dx                   ; [extra] original cursor position

    ; Set initial cursor position
    mov ax, 0x0040
    mov ds, ax
    push bx
    mov bl, bh
    call _set_cursor_bda_and_hw
    pop bx

    ; DS = BDA, BH = page
    jcxz .ws_skip_loop
    jmp .ws_char_loop
.ws_skip_loop:
    jmp .ws_after_loop

.ws_char_loop:
    ; Read character (and maybe attribute) from string
    push ds
    mov ds, [bp-2]            ; DS = string segment (SS-relative access)

    mov al, [si]              ; AL = character
    inc si
    mov ah, [bp-6]            ; AH = default attribute (SS-relative)
    test byte [bp-4], 0x02    ; Mode bit 1: char/attr pairs?
    jz .ws_got_char
    mov ah, [si]              ; AH = attribute from string
    inc si
.ws_got_char:
    pop ds                    ; DS = BDA

    ; AL=char, AH=attr — handle special characters
    cmp al, 0x07
    je .ws_next_char          ; BEL: skip
    cmp al, 0x08
    je .ws_bs
    cmp al, 0x0A
    je .ws_lf
    cmp al, 0x0D
    je .ws_cr

    ; Normal character: write char+attr to VRAM at cursor
    push ax
    call _get_cursor_bda      ; DH=row, DL=col
    call _cursor_to_vram_di   ; DI = offset

    ; Page offset
    push cx
    mov al, bh
    xor ah, ah
    mov cl, 12
    shl ax, cl
    pop cx
    add di, ax

    pop ax                    ; AX = char(AL) + attr(AH)

    push es
    push ax
    mov ax, VIDEO_SEG
    mov es, ax
    pop ax
    mov word [es:di], ax      ; Write char+attr
    pop es

    ; Advance cursor
    call _get_cursor_bda
    inc dl
    cmp dl, TEXT_COLS
    jb .ws_set_cursor
    xor dl, dl
    inc dh
    jmp .ws_check_scroll

.ws_bs:
    call _get_cursor_bda
    cmp dl, 0
    je .ws_next_char
    dec dl
    jmp .ws_set_cursor

.ws_lf:
    call _get_cursor_bda
    inc dh
    jmp .ws_check_scroll

.ws_cr:
    call _get_cursor_bda
    xor dl, dl
    jmp .ws_set_cursor

.ws_check_scroll:
    cmp dh, TEXT_ROWS
    jb .ws_set_cursor
    mov dh, TEXT_ROWS - 1

    ; Scroll up 1 line
    push dx
    push cx
    push bx
    mov ax, VIDEO_SEG
    mov ds, ax
    mov es, ax
    cld
    mov ah, 0x07
    call _scroll_up_fullscreen
    mov ax, 0x0040
    mov ds, ax
    pop bx
    pop cx
    pop dx

.ws_set_cursor:
    push bx
    mov bl, bh
    call _set_cursor_bda_and_hw
    pop bx

.ws_next_char:
    dec cx
    jz .ws_after_loop
    jmp .ws_char_loop

.ws_after_loop:
    ; Check if cursor should be restored (modes 0 and 2: bit 0 = 0)
    test byte [bp-4], 0x01
    jnz .ws_keep_cursor
    ; Restore original cursor position
    pop dx                    ; [extra] original position
    push bx
    mov bl, bh
    call _set_cursor_bda_and_hw
    pop bx
    jmp .ws_cleanup

.ws_keep_cursor:
    add sp, 2                 ; Discard saved original cursor

.ws_cleanup:
    add sp, 6                 ; Deallocate locals
    pop bp

    pop es
    pop ds
    pop di
    pop si
    pop dx
    pop cx
    pop bx
    pop ax
    clc
    iret

; =============================================================================
; INT 0x13 - Disk Services (stub)
; Sets AX=1 (error), CF=1, and returns.
; =============================================================================
int13_handler:
    mov ax, 0x0001          ; Error code
    stc                     ; Carry flag set = error
    iret

; =============================================================================
; INT 0x16 - Keyboard Services (stub)
; Sets AX=1 (error), CF=1, and returns.
; =============================================================================
int16_handler:
    mov ax, 0x0001          ; Error code
    stc                     ; Carry flag set = error
    iret

; =============================================================================
; Common Interrupt Handler
; Called for any unhandled interrupt.
; Saves all registers, writes an error message directly to video memory
; (CGA text mode at 0xB800:0000), restores all registers, sets AX=1, and
; returns via IRET.
; =============================================================================
common_handler:
    ; Save all registers (AX is not preserved: it holds the error return code)
    push bx
    push cx
    push dx
    push si
    push di
    push bp
    push ds
    push es

    ; Point ES:DI at top-left of CGA text video memory
    mov ax, 0xB800
    mov es, ax
    xor di, di              ; Offset 0 = row 0, column 0

    ; Point DS:SI at error message (in this ROM's code segment)
    push cs
    pop ds
    mov si, err_msg

.write_loop:
    lodsb                   ; AL = next character from err_msg
    test al, al             ; Null terminator?
    jz .done
    mov ah, 0x4F            ; Attribute: white text on red background
    stosw                   ; Write character + attribute to video memory
    jmp .write_loop

.done:
    ; Restore all saved registers
    pop es
    pop ds
    pop bp
    pop di
    pop si
    pop dx
    pop cx
    pop bx

    mov ax, 1               ; Return error code in AX
    iret

; =============================================================================
; Helper Subroutines (called from INT 10h handlers)
; =============================================================================

; ---------------------------------------------------------------------------
; _get_cursor_bda: Read cursor position for a page from BDA
;   In:  BH = page number, DS = 0x0040 (BDA segment)
;   Out: DH = row, DL = column
;   Preserves: all registers except DX
; ---------------------------------------------------------------------------
_get_cursor_bda:
    push bx
    mov bl, bh
    xor bh, bh
    shl bx, 1
    mov dx, word [BDA_CURSOR_POS + bx]
    pop bx
    ret

; ---------------------------------------------------------------------------
; _cursor_to_vram_di: Compute VRAM byte offset from cursor position
;   In:  DH = row, DL = column
;   Out: DI = byte offset
;   Clobbers: AX
; ---------------------------------------------------------------------------
_cursor_to_vram_di:
    push bx
    mov al, dh
    xor ah, ah
    mov bl, TEXT_COLS
    mul bl                      ; AX = row * 80
    xor bh, bh
    mov bl, dl
    add ax, bx                  ; AX = row*80 + col
    shl ax, 1                   ; AX = byte offset
    mov di, ax
    pop bx
    ret

; ---------------------------------------------------------------------------
; _set_cursor_bda_and_hw: Write cursor position to BDA and program CRT
;   In:  DH = row, DL = column, BL = page number, DS = 0x0040 (BDA segment)
;   Out: (nothing)
;   Clobbers: AX
;   Preserves: BX, DX
; ---------------------------------------------------------------------------
_set_cursor_bda_and_hw:
    push bx
    push dx

    ; Save to BDA
    xor bh, bh
    push bx
    shl bx, 1
    mov word [BDA_CURSOR_POS + bx], dx
    pop bx                      ; BL = page, BH = 0

    ; Update hardware only for the active page
    cmp bl, byte [BDA_ACTIVE_PAGE]
    jne .scbh_done

    ; Compute linear position = row * 80 + col
    mov al, dh
    mov bl, TEXT_COLS
    mul bl                      ; AX = row * 80
    xor bh, bh
    mov bl, dl
    add ax, bx                  ; AX = linear position
    mov bx, ax

    ; Program CRT cursor position
    mov dx, CRT_INDEX
    mov al, CRT_CURSOR_HIGH
    out dx, al
    mov dx, CRT_DATA
    mov al, bh
    out dx, al

    mov dx, CRT_INDEX
    mov al, CRT_CURSOR_LOW
    out dx, al
    mov dx, CRT_DATA
    mov al, bl
    out dx, al

.scbh_done:
    pop dx
    pop bx
    ret

; ---------------------------------------------------------------------------
; _scroll_up_fullscreen: Scroll entire screen up by 1 line
;   In:  AH = fill attribute for the new blank bottom line
;   Requires: DS = ES = VIDEO_SEG (0xB800), direction flag clear (CLD)
;   Clobbers: AX, CX, SI, DI
; ---------------------------------------------------------------------------
_scroll_up_fullscreen:
    mov si, TEXT_COLS * 2            ; Source: start of row 1
    xor di, di                       ; Dest: start of row 0
    mov cx, TEXT_COLS * (TEXT_ROWS - 1) ; 80 * 24 = 1920 words
    rep movsw
    ; Fill bottom row with spaces
    mov al, 0x20                     ; Space character (AH already has attribute)
    mov cx, TEXT_COLS
    rep stosw
    ret

; =============================================================================
; Pad ROM image to exactly ROM_SIZE bytes
; =============================================================================
times (ROM_SIZE - ($ - $$)) db 0