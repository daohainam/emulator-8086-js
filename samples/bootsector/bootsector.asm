org 0x7C00          ; Địa chỉ tải chuẩn cho bootloader

start:
    mov ax, 0xb800  ; Phân đoạn bộ nhớ video (VGA text mode)
    mov es, ax
    xor di, di      ; Bắt đầu tại góc trên cùng bên trái (offset 0)

    mov si, msg     ; Trỏ SI vào chuỗi cần xử lý

process_loop:
    lodsb           ; Tải ký tự từ [SI] vào AL, SI tự tăng
    or al, al       ; Kiểm tra ký tự kết thúc chuỗi (null-terminator)
    jz done         ; Nếu là 0, kết thúc

    ; logic chuyển đổi chữ thường thành chữ hoa
    cmp al, 'a'     ; Kiểm tra nếu ký tự < 'a'
    jb write_video
    cmp al, 'z'     ; Kiểm tra nếu ký tự > 'z'
    ja write_video
    
    and al, 0xDF    ; Xóa bit thứ 5 để chuyển thành chữ hoa (0xDF = 11011111b)

write_video:
    mov ah, 0x07    ; Thuộc tính màu (07h = chữ trắng trên nền đen)
    stosw           ; Ghi AX (ký tự + màu) vào [ES:DI], DI tự tăng 2
    jmp process_loop

done:
    hlt             ; Dừng CPU

msg db 'Welcome to emulator-8086-js computer', 0

times 510-($-$$) db 0 ; Đổ đầy file cho đủ 512 bytes
dw 0xAA55