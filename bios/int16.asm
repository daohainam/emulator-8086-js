; =============================================================================
; INT 0x16 - Keyboard Services
; =============================================================================
;
; Implements standard keyboard BIOS subfunctions using the BIOS Data Area
; (BDA) keyboard circular buffer.  All interaction with the keyboard is done
; by reading/writing the following BDA locations (segment 0x0040):
;
;   Offset  Size  Name              Description
;   0x17    byte  BDA_KBD_STATUS1   Shift/toggle flags (same bits as IBM BDA)
;                                     Bit 0: Right Shift pressed
;                                     Bit 1: Left  Shift pressed
;                                     Bit 2: Ctrl  pressed
;                                     Bit 3: Alt   pressed
;                                     Bit 4: Scroll Lock active
;                                     Bit 5: Num   Lock active
;                                     Bit 6: Caps  Lock active
;                                     Bit 7: Insert active
;   0x18    byte  BDA_KBD_STATUS2   Extended shift flags
;   0x1A    word  BDA_KBD_HEAD      Head pointer (BDA-relative offset into
;                                   the circular buffer, range 0x1E–0x3C)
;   0x1C    word  BDA_KBD_TAIL      Tail pointer (same range as head)
;   0x1E–   word  BDA_KBD_BUF       Circular buffer: 16 entries × 2 bytes
;   0x3C                              Each word: low byte = ASCII code
;                                                high byte = scan code
;
; The buffer is EMPTY when head == tail.
; The buffer is FULL  when next_tail == head  (one entry is always sacrificed).
;
; The host (JavaScript) writes keystrokes into BDA_KBD_BUF and updates
; BDA_KBD_TAIL.  This handler reads/removes them.
;
; Subfunctions:
;   AH=0x00 / 0x10  Read (blocking) keystroke from buffer
;                   Returns: AL = ASCII code, AH = scan code
;                   Advances head; spins until a key is available.
;   AH=0x01 / 0x11  Check keystroke without removing it
;                   Returns: ZF=0 + AX=key  if a key is available
;                            ZF=1           if the buffer is empty
;                   Does not modify the buffer.
;   AH=0x02         Get shift status
;                   Returns: AL = BDA_KBD_STATUS1
;   AH=0x03         Set typematic rate (stub — always succeeds, no-op)
;   AH=0x05         Push keystroke into buffer
;                   In:  CH = scan code, CL = ASCII code
;                   Out: AL = 0  success
;                        AL = 1  buffer full
;   AH=0x12         Extended get shift status
;                   Returns: AL = BDA_KBD_STATUS1, AH = BDA_KBD_STATUS2
; =============================================================================

; BDA keyboard constants (segment 0x0040 relative)
BDA_KBD_STATUS1  equ 0x17       ; Keyboard status flags byte 1
BDA_KBD_STATUS2  equ 0x18       ; Keyboard status flags byte 2
BDA_KBD_HEAD     equ 0x1A       ; Buffer head pointer  (word, BDA offset)
BDA_KBD_TAIL     equ 0x1C       ; Buffer tail pointer  (word, BDA offset)
BDA_KBD_BUF      equ 0x1E       ; First entry of circular buffer
BDA_KBD_BUF_END  equ 0x3E       ; One past the last entry  (wraps to BDA_KBD_BUF)

; -----------------------------------------------------------------------------
int16_handler:
; Build a BP-based frame so we can reach the FLAGS word that INT pushed onto
; the stack.  After the INT instruction the stack contains (low → high addr):
;   [SP+0] caller IP, [SP+2] caller CS, [SP+4] caller FLAGS
; After "push bp / mov bp, sp":
;   [bp+0] old BP,  [bp+2] caller IP,  [bp+4] caller CS,  [bp+6] caller FLAGS
; Subsequent push ds / push bx do NOT change bp, so [bp+6] always reaches the
; caller's FLAGS — allowing us to force-clear or force-set ZF before IRET.
; -----------------------------------------------------------------------------
    push bp
    mov  bp, sp                 ; [bp+6] = caller FLAGS (written by INT)
    push ds
    push bx

    ; Point DS at BDA segment
    mov  bx, 0x0040
    mov  ds, bx

    ; Dispatch on AH — register is still intact at this point
    cmp  ah, 0x00
    je   .read_key
    cmp  ah, 0x10
    je   .read_key
    cmp  ah, 0x01
    je   .check_key
    cmp  ah, 0x11
    je   .check_key
    cmp  ah, 0x02
    je   .shift_status
    cmp  ah, 0x03
    je   .set_typematic
    cmp  ah, 0x05
    je   .push_key
    cmp  ah, 0x12
    je   .ext_shift_status

    ; Unknown subfunction — return AX=1, CF=1
    pop  bx
    pop  ds
    pop  bp
    mov  ax, 0x0001
    stc
    iret

; ---------------------------------------------------------------------------
; AH=0x00 / 0x10 – Read Keystroke (blocking)
;   Spin-waits until the buffer is non-empty, then removes and returns the
;   front entry.  Returns AL = ASCII, AH = scan code (replaces caller AX).
; ---------------------------------------------------------------------------
.read_key:
.read_wait:
    mov  bx, word [BDA_KBD_HEAD]
    cmp  bx, word [BDA_KBD_TAIL]
    je   .read_wait             ; Buffer empty — keep polling

    ; Read entry word: low byte = ASCII (→ AL), high byte = scan (→ AH)
    mov  ax, word [bx]

    ; Advance head pointer with wrap-around
    add  bx, 2
    cmp  bx, BDA_KBD_BUF_END
    jb   .read_nowrap
    mov  bx, BDA_KBD_BUF
.read_nowrap:
    mov  word [BDA_KBD_HEAD], bx

    pop  bx
    pop  ds
    pop  bp
    clc
    iret

; ---------------------------------------------------------------------------
; AH=0x01 / 0x11 – Check Keystroke (non-destructive peek)
;   The caller's FLAGS word on the stack is modified directly so that IRET
;   restores the correct ZF.  AX is updated only when a key is available.
; ---------------------------------------------------------------------------
.check_key:
    mov  bx, word [BDA_KBD_HEAD]
    cmp  bx, word [BDA_KBD_TAIL]
    je   .check_empty

    ; Key available: peek at front entry, report ZF=0 to caller
    mov  ax, word [bx]
    and  word [bp+6], 0xFFBF    ; Clear bit 6 (ZF) in caller FLAGS

    pop  bx
    pop  ds
    pop  bp
    iret

.check_empty:
    ; No key: report ZF=1 to caller, leave AX unchanged
    or   word [bp+6], 0x0040    ; Set bit 6 (ZF) in caller FLAGS

    pop  bx
    pop  ds
    pop  bp
    iret

; ---------------------------------------------------------------------------
; AH=0x02 – Get Keyboard Shift Status
;   Returns: AL = BDA_KBD_STATUS1 (AH unchanged)
; ---------------------------------------------------------------------------
.shift_status:
    mov  al, byte [BDA_KBD_STATUS1]
    pop  bx
    pop  ds
    pop  bp
    clc
    iret

; ---------------------------------------------------------------------------
; AH=0x03 – Set Typematic Rate  (stub: always succeeds, no hardware action)
;   In: BH = rate, BL = delay — both ignored
; ---------------------------------------------------------------------------
.set_typematic:
    pop  bx
    pop  ds
    pop  bp
    clc
    iret

; ---------------------------------------------------------------------------
; AH=0x05 – Push Keystroke into Buffer
;   In:  CH = scan code, CL = ASCII code
;   Out: AL = 0  entry enqueued successfully
;        AL = 1  buffer full, entry discarded
; ---------------------------------------------------------------------------
.push_key:
    mov  bx, word [BDA_KBD_TAIL]

    ; Compute next_tail with wrap-around
    mov  ax, bx
    add  ax, 2
    cmp  ax, BDA_KBD_BUF_END
    jb   .push_nowrap
    mov  ax, BDA_KBD_BUF
.push_nowrap:
    ; Buffer is full when next_tail would equal head
    cmp  ax, word [BDA_KBD_HEAD]
    je   .push_full

    ; Write entry: low byte = ASCII (CL), high byte = scan code (CH)
    mov  byte [bx],   cl
    mov  byte [bx+1], ch

    ; Advance tail
    mov  word [BDA_KBD_TAIL], ax

    pop  bx
    pop  ds
    pop  bp
    mov  al, 0                  ; Success
    clc
    iret

.push_full:
    pop  bx
    pop  ds
    pop  bp
    mov  al, 1                  ; Buffer full
    stc
    iret

; ---------------------------------------------------------------------------
; AH=0x12 – Extended Get Shift Status
;   Returns: AL = BDA_KBD_STATUS1, AH = BDA_KBD_STATUS2
; ---------------------------------------------------------------------------
.ext_shift_status:
    mov  al, byte [BDA_KBD_STATUS1]
    mov  ah, byte [BDA_KBD_STATUS2]
    pop  bx
    pop  ds
    pop  bp
    clc
    iret
