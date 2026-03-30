import bpy
import json
import socket
import threading
import queue

_server_thread = None
_server_socket = None
_running = False
_action_queue = queue.Queue()

# Default port for MCP
PORT = 8123

def process_queue():
    """実行待ちのアクションをメインスレッドで処理（Blender制限回避）"""
    while not _action_queue.empty():
        try:
            client_socket, cmd = _action_queue.get_nowait()
            response = execute_command(cmd)
            client_socket.sendall((json.dumps(response) + '\n').encode('utf-8'))
            client_socket.close()
        except Exception as e:
            print("MCP Queue Error:", str(e))
    # 0.1秒ごとに再度呼び出し
    return 0.1 if _running else None

def execute_command(cmd):
    """Blender APIを使ってコマンドを実行（メインスレッド内で動作）"""
    action = cmd.get("action")
    kwargs = cmd.get("kwargs", {})
    
    try:
        if action == "add_cube":
            size = kwargs.get("size", 2.0)
            location = kwargs.get("location", (0, 0, 0))
            bpy.ops.mesh.primitive_cube_add(size=size, location=location)
            return {"status": "success", "message": f"Cube added at {location}"}
            
        elif action == "delete_all":
            bpy.ops.object.select_all(action='SELECT')
            bpy.ops.object.delete()
            return {"status": "success", "message": "All objects deleted"}
            
        elif action == "get_objects":
            objs = [{"name": o.name, "type": o.type, "location": list(o.location)} for o in bpy.data.objects]
            return {"status": "success", "objects": objs}
            
        elif action == "render":
            filepath = kwargs.get("filepath", "//render.png")
            bpy.context.scene.render.filepath = filepath
            bpy.ops.render.render(write_still=True)
            return {"status": "success", "message": f"Render saved to {filepath}"}
            
        elif action == "save_blend":
            filepath = kwargs.get("filepath")
            if not filepath:
                return {"status": "error", "message": "filepath is required"}
            bpy.ops.wm.save_as_mainfile(filepath=filepath)
            return {"status": "success", "message": f"Saved as {filepath}"}
            
        elif action == "execute_python":
            code = kwargs.get("code")
            if not code:
                return {"status": "error", "message": "code is required"}
            # 安全のため、グローバル空間で実行
            local_vars = {}
            exec(code, {"bpy": bpy}, local_vars)
            return {"status": "success", "message": "Python executed successfully", "output": str(local_vars)}
            
        else:
            return {"status": "error", "message": f"Unknown action: {action}"}
            
    except Exception as e:
        return {"status": "error", "message": str(e)}

def _server_loop():
    """ソケットサーバーのループ（別スレッド）"""
    global _running, _server_socket
    while _running:
        try:
            client, addr = _server_socket.accept()
            print(f"MCP Connection from {addr}")
            data = client.recv(4096).decode('utf-8')
            if not data:
                client.close()
                continue
                
            cmd = json.loads(data)
            # Blenderのメインスレッドで実行するためにキューへ渡す
            _action_queue.put((client, cmd))
            
        except socket.timeout:
            pass
        except Exception as e:
            if _running:
                print("MCP Server Error:", str(e))

def start_server():
    """サーバー開始"""
    global _running, _server_thread, _server_socket
    
    if _running:
        return {"status": "already_running"}
        
    try:
        _server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        _server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        _server_socket.bind(('127.0.0.1', PORT))
        _server_socket.listen(5)
        _server_socket.settimeout(1.0) # ループ終了判定のためタイムアウトを設ける
        
        _running = True
        _server_thread = threading.Thread(target=_server_loop, daemon=True)
        _server_thread.start()
        
        # タイマーの登録
        if not bpy.app.timers.is_registered(process_queue):
            bpy.app.timers.register(process_queue)
            
        print(f"Blender MCP Server started on port {PORT}")
        return {"status": "success", "port": PORT}
        
    except Exception as e:
        print(f"Failed to start MCP server: {e}")
        return {"status": "error", "message": str(e)}

def stop_server():
    """サーバー終了"""
    global _running, _server_socket, _server_thread
    
    if not _running:
        return {"status": "not_running"}
        
    _running = False
    if _server_socket:
        try:
            _server_socket.close()
        except:
            pass
        _server_socket = None
        
    if _server_thread:
        _server_thread.join(timeout=2.0)
        _server_thread = None
        
    if bpy.app.timers.is_registered(process_queue):
        bpy.app.timers.unregister(process_queue)
        
    print("Blender MCP Server stopped")
    return {"status": "success"}

def is_running():
    return _running
