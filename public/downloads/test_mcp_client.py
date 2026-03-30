import socket
import json

def send_command(action, **kwargs):
    client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        client.connect(('127.0.0.1', 8123))
        payload = {"action": action, "kwargs": kwargs}
        client.sendall((json.dumps(payload) + "\n").encode('utf-8'))
        
        response = b""
        while True:
            chunk = client.recv(4096)
            if not chunk:
                break
            response += chunk
            
        print(f"[{action}] Response: {response.decode('utf-8').strip()}")
        
    except ConnectionRefusedError:
        print("MCP Server is not running. Start it from Blender Addon Preferences first.")
    finally:
        client.close()

if __name__ == "__main__":
    import time
    
    print("Sending 'delete_all' command...")
    send_command("delete_all")
    
    time.sleep(1)
    
    print("Sending 'add_cube' command...")
    send_command("add_cube", size=3.0, location=(0, 0, 1.5))
    
    time.sleep(1)
    
    print("Sending 'get_objects' command...")
    send_command("get_objects")
    
    time.sleep(1)
    
    print("Sending 'execute_python' command...")
    code = '''
bpy.ops.mesh.primitive_monkey_add(location=(3, 0, 2))
suzanne = bpy.context.active_object
suzanne.name = "MyAwesomeMonkey"
local_vars["success"] = True
'''
    send_command("execute_python", code=code)
