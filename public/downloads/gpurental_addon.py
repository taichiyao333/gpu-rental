# ─────────────────────────────────────────────────────────────────────────────
# GPURental Blender Addon v2.2.0
# 
# Blenderから直接 gpurental.jp のGPUでレンダリングできるアドオン。
# GPU選択・ポイント残高表示・進捗トラッキング対応。
#
# インストール方法:
#   1. Blender → 編集 → プリファレンス → アドオン → インストール
#   2. このファイル (gpurental_addon.py) を選択
#   3. 「GPURental Cloud Render」を有効化
#   4. サイドバー(N) → GPURental タブからログイン＆レンダリング
# ─────────────────────────────────────────────────────────────────────────────

bl_info = {
    "name": "GPURental Cloud Render",
    "author": "METADATALAB.INC",
    "version": (2, 3, 1),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar > GPURental",
    "description": "gpurental.jp のクラウドGPUを選択してレンダリングを実行",
    "category": "Render",
    "doc_url": "https://gpurental.jp/workspace/guide.html",
}

import bpy
import os
import json
import tempfile
import threading
import time
import zipfile

try:
    import blender_mcp_server
except ImportError:
    blender_mcp_server = None

from bpy.props import (
    StringProperty, IntProperty, EnumProperty, BoolProperty, FloatProperty,
    CollectionProperty
)

# ── Globals ──────────────────────────────────────────────────────────────────
_server_status = {}
_active_jobs = []
_gpu_list = []          # 予約済みGPU（レンダリング可能）
_available_to_book = [] # 未予約GPU（予約誘導用）
_active_session = None  # User's currently active GPU session
_user_balance = 0       # User's point balance
_has_reservation = False  # 有効な予約があるか
_no_reservation_msg = '' # 未予約時の誘導メッセージ
_book_url = 'https://gpurental.jp/portal/'
_polling_thread = None
_polling_active = False

# ── セッション管理用グローバル ──
_session_remaining_min = -1   # 残り分数（-1=未取得）
_session_gpu_name = ''        # セッション中GPU名
_session_end_jst = ''         # 終了時刻（JST文字列）
_session_warn = False         # 残り30分未満警告
_session_can_extend = False   # 延長可能か
_session_keep_alive = False   # 「セッション維持」アクティブ

# ── スレッドによるアップロード状態 ──
_upload_state = {
    'running': False,
    'done': False,
    'error': None,
    'result': None,
    'message': '',
}

# ── HTTP helpers ─────────────────────────────────────────────────────────────
def api_request(method, endpoint, token=None, data=None, files=None):
    import urllib.request
    import urllib.error
    
    prefs = bpy.context.preferences.addons[__name__].preferences
    base_url = prefs.server_url.rstrip('/')
    url = f"{base_url}/api/blender{endpoint}"
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 KHTML, like Gecko GPURentalAddon/2.3.0'
    }
    if token:
        headers['Authorization'] = f'Bearer {token}'
    
    if files:
        boundary = '----GPURentalBoundary' + str(int(time.time()))
        body = b''
        if data:
            body += f'--{boundary}\r\n'.encode()
            body += b'Content-Disposition: form-data; name="settings"\r\n'
            body += b'Content-Type: application/json\r\n\r\n'
            body += json.dumps(data).encode() + b'\r\n'
        for field_name, (filename, filedata) in files.items():
            body += f'--{boundary}\r\n'.encode()
            body += f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'.encode()
            body += b'Content-Type: application/octet-stream\r\n\r\n'
            body += filedata + b'\r\n'
        body += f'--{boundary}--\r\n'.encode()
        headers['Content-Type'] = f'multipart/form-data; boundary={boundary}'
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
    elif data:
        headers['Content-Type'] = 'application/json'
        body = json.dumps(data).encode()
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
    else:
        req = urllib.request.Request(url, headers=headers, method=method)
    
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read().decode())
            return {'error': err.get('error', str(e))}
        except:
            return {'error': f'HTTP {e.code}: {e.reason}'}
    except urllib.error.URLError as e:
        return {'error': f'接続エラー: {e.reason}'}
    except Exception as e:
        return {'error': str(e)}


def download_file(url, token, save_path):
    import urllib.request
    req = urllib.request.Request(url)
    req.add_header('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 KHTML, like Gecko GPURentalAddon/2.3.0')
    req.add_header('Authorization', f'Bearer {token}')
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            with open(save_path, 'wb') as f:
                while True:
                    chunk = resp.read(8192)
                    if not chunk:
                        break
                    f.write(chunk)
        return True
    except Exception as e:
        print(f"Download error: {e}")
        return False


# ── GPU enum items callback ──────────────────────────────────────────────────
def get_gpu_items(self, context):
    """Dynamic enum items for GPU dropdown (予約済みGPUのみ)"""
    items = []

    # アクティブセッション優先
    if _active_session:
        items.append((
            str(_active_session['gpu_id']),
            f"\u26a1 {_active_session['gpu_name']} (\u30bb\u30c3\u30b7\u30e7\u30f3\u4e2d \u2014 \u00a5{_active_session['price_per_hour']}/h)",
            f"\u73fe\u5728\u5229\u7528\u4e2d\u306e\u30bb\u30c3\u30b7\u30e7\u30f3: {_active_session['gpu_name']}",
        ))

    # 予約済みGPU
    for gpu in _gpu_list:
        if _active_session and gpu['id'] == _active_session['gpu_id']:
            continue
        end_info = f" | \u671f\u9650: {gpu.get('reservation_end', 'N/A')}" if gpu.get('reservation_end') else ''
        label = f"\u2705 {gpu['name']} ({gpu.get('vram_gb', '?')}GB) \u2014 \u00a5{gpu['price_per_hour']}/h{end_info}"
        desc  = f"\u4e88\u7d04\u6e08\u307f GPU / VRAM: {gpu.get('vram_gb', '?')}GB / {gpu.get('location', '\u65e5\u672c')} / \u00a5{gpu['price_per_hour']}/\u6642\u9593"
        items.append((str(gpu['id']), label, desc))

    if not items:
        items.append(('0', '\u4e88\u7d04\u6e08\u307fGPU\u304c\u3042\u308a\u307e\u305b\u3093 \u2014 gpurental.jp\u3067\u4e88\u7d04\u3057\u3066\u304f\u3060\u3055\u3044', '\u30af\u30e9\u30a6\u30c9\u30ec\u30f3\u30c0\u30ea\u30f3\u30b0\u306b\u306fGPU\u306e\u4e88\u7d04\u304c\u5fc5\u8981\u3067\u3059'))

    return items



# ── Addon Preferences ────────────────────────────────────────────────────────
class GPURentalPreferences(bpy.types.AddonPreferences):
    bl_idname = __name__
    
    server_url: StringProperty(
        name="サーバーURL",
        default="https://gpurental.jp",
        description="GPURentalサーバーのURL",
    )
    auth_token: StringProperty(
        name="認証トークン", default="",
        description="GPURentalのログイントークン", subtype='PASSWORD',
    )
    email: StringProperty(name="メールアドレス", default="")
    password: StringProperty(name="パスワード", default="", subtype='PASSWORD')
    
    enable_mcp: BoolProperty(
        name="ローカルMCPサーバー (Antigravity連携用)",
        default=False,
        description="外部からのJSONコマンドを受け付けるローカルソケットサーバーを起動",
        update=lambda self, context: bpy.ops.gpurental.mcp_toggle()
    )

    def draw(self, context):
        layout = self.layout
        layout.label(text="GPURental アカウント設定", icon='PREFERENCES')
        layout.prop(self, "server_url")
        box = layout.box()
        box.label(text="ログイン", icon='LOCKED')
        box.prop(self, "email")
        box.prop(self, "password")
        row = box.row()
        row.operator("gpurental.login", icon='CHECKMARK')
        if self.auth_token:
            box.label(text="✅ ログイン済み", icon='CHECKMARK')

        # MCPサーバー UI
        if blender_mcp_server:
            mcp_box = layout.box()
            mcp_box.label(text="開発・外部連携", icon='CONSOLE')
            mcp_box.prop(self, "enable_mcp")
            if blender_mcp_server.is_running():
                mcp_box.label(text="🟢 MCPサーバー実行中 (ポート 8123)", icon='PLAY')
            else:
                mcp_box.label(text="🔴 MCPサーバー停止中", icon='PAUSE')


# ── Operators ────────────────────────────────────────────────────────────────
class GPURENTAL_OT_MCP_Toggle(bpy.types.Operator):
    bl_idname = "gpurental.mcp_toggle"
    bl_label = "MCPサーバー切替"
    bl_description = "MCPサーバーを開始または停止"

    def execute(self, context):
        if not blender_mcp_server:
            self.report({'ERROR'}, "blender_mcp_server.py が見つかりません")
            return {'CANCELLED'}
        prefs = context.preferences.addons[__name__].preferences
        if prefs.enable_mcp:
            res = blender_mcp_server.start_server()
            if res.get('status') == 'success':
                self.report({'INFO'}, f"MCP サーバー開始: ポート {res.get('port')}")
            elif res.get('status') != 'already_running':
                self.report({'ERROR'}, f"開始エラー: {res.get('message')}")
        else:
            blender_mcp_server.stop_server()
            self.report({'INFO'}, "MCP サーバー停止")
        return {'FINISHED'}

class GPURENTAL_OT_Login(bpy.types.Operator):
    bl_idname = "gpurental.login"
    bl_label = "ログイン"
    bl_description = "GPURentalにログインしてトークンを取得"
    
    def execute(self, context):
        prefs = context.preferences.addons[__name__].preferences
        if not prefs.email or not prefs.password:
            self.report({'ERROR'}, "メールアドレスとパスワードを入力してください")
            return {'CANCELLED'}
        
        import urllib.request, urllib.error
        base_url = prefs.server_url.rstrip('/')
        url = f"{base_url}/api/auth/login"
        data = json.dumps({'email': prefs.email, 'password': prefs.password}).encode()
        req = urllib.request.Request(url, data=data, method='POST')
        req.add_header('Content-Type', 'application/json')
        req.add_header('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 KHTML, like Gecko GPURentalAddon/2.3.0')
        
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                result = json.loads(resp.read().decode())
                if result.get('token'):
                    prefs.auth_token = result['token']
                    prefs.password = ''
                    self.report({'INFO'}, f"✅ ログイン成功: {result.get('user', {}).get('username', '')}")
                    # Fetch GPUs and balance
                    bpy.ops.gpurental.fetch_gpus()
                    bpy.ops.gpurental.check_status()
                    return {'FINISHED'}
                else:
                    self.report({'ERROR'}, result.get('error', 'ログイン失敗'))
                    return {'CANCELLED'}
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode())
                self.report({'ERROR'}, err.get('error', f'HTTP {e.code}'))
            except:
                self.report({'ERROR'}, f'ログインエラー: HTTP {e.code}')
            return {'CANCELLED'}
        except Exception as e:
            self.report({'ERROR'}, f'接続エラー: {e}')
            return {'CANCELLED'}


class GPURENTAL_OT_CheckStatus(bpy.types.Operator):
    bl_idname = "gpurental.check_status"
    bl_label = "サーバー状態を確認"
    
    def execute(self, context):
        global _server_status
        prefs = context.preferences.addons[__name__].preferences
        if not prefs.auth_token:
            self.report({'ERROR'}, "先にログインしてください")
            return {'CANCELLED'}
        result = api_request('GET', '/status', token=prefs.auth_token)
        if 'error' in result:
            self.report({'ERROR'}, result['error'])
            return {'CANCELLED'}
        _server_status = result
        return {'FINISHED'}


class GPURENTAL_OT_FetchGPUs(bpy.types.Operator):
    bl_idname = "gpurental.fetch_gpus"
    bl_label = "GPU一覧を取得"
    bl_description = "利用可能なGPUとポイント残高を取得"
    
    def execute(self, context):
        global _gpu_list, _available_to_book, _active_session, _user_balance
        global _has_reservation, _no_reservation_msg, _book_url
        prefs = context.preferences.addons[__name__].preferences
        if not prefs.auth_token:
            self.report({'ERROR'}, "先にログインしてください")
            return {'CANCELLED'}

        # GPU一覧取得
        gpu_result = api_request('GET', '/gpus', token=prefs.auth_token)
        if 'error' in gpu_result:
            self.report({'ERROR'}, gpu_result['error'])
            return {'CANCELLED'}

        _gpu_list         = gpu_result.get('gpus', [])           # 予約済みGPU
        _available_to_book = gpu_result.get('available_to_book', [])  # 予約誘導用
        _active_session   = gpu_result.get('active_session')
        _has_reservation  = bool(gpu_result.get('has_reservation', False))
        _no_reservation_msg = gpu_result.get('message', '')
        _book_url         = gpu_result.get('book_url', 'https://gpurental.jp/portal/')

        # 残高取得
        bal_result = api_request('GET', '/balance', token=prefs.auth_token)
        if not isinstance(bal_result, dict) or 'error' in bal_result:
            _user_balance = 0
        else:
            # APIから文字列で返ってくることがあるため安全にキャスト
            try:
                _user_balance = int(float(bal_result.get('points', 0)))
            except (TypeError, ValueError):
                _user_balance = 0

        gpu_count = len(_gpu_list)
        session_msg = f" | セッション: {_active_session['gpu_name']}" if _active_session else ""
        if gpu_count == 0 and not _active_session:
            self.report({'WARNING'}, f"予約済みGPUがありません。gpurental.jp で予約してください。")
        else:
            self.report({'INFO'}, f"🎮 {gpu_count}台の予約済みGPU | 💰 {_user_balance:,}pt{session_msg}")
        return {'FINISHED'}


class GPURENTAL_OT_SubmitRender(bpy.types.Operator):
    bl_idname = "gpurental.submit_render"
    bl_label = "☁ クラウドレンダリング開始"
    bl_description = "選択したGPUでクラウドレンダリングを実行。実行前に確認ダイアログが表示されます"

    def invoke(self, context, event):
        """invoke_confirm で確認ダイアログ → 「押した感」が生まれる"""
        prefs = context.preferences.addons[__name__].preferences
        if not prefs.auth_token:
            self.report({'ERROR'}, "先にログインしてください")
            return {'CANCELLED'}
        gr = context.scene.gpurental
        if not gr.selected_gpu or gr.selected_gpu == '0':
            self.report({'ERROR'}, "GPUを選択してください")
            return {'CANCELLED'}
        if _upload_state['running']:
            self.report({'WARNING'}, "アップロード中です。完了をお待ちください")
            return {'CANCELLED'}
        return context.window_manager.invoke_confirm(self, event)

    def execute(self, context):
        global _upload_state, _user_balance
        if _upload_state['running']:
            self.report({'WARNING'}, "アップロード中です")
            return {'CANCELLED'}

        prefs = context.preferences.addons[__name__].preferences
        scene = context.scene
        gr = scene.gpurental

        gpu_id = int(gr.selected_gpu) if gr.selected_gpu and gr.selected_gpu != '0' else 0
        if gpu_id == 0:
            self.report({'ERROR'}, "GPUを選択してください")
            return {'CANCELLED'}

        try:
            balance_int = int(float(_user_balance))
        except:
            balance_int = 0
        if balance_int <= 0:
            self.report({'ERROR'}, f"ポイント残高が不足しています（{balance_int}pt）")
            return {'CANCELLED'}

        # .blend を一時保存
        self.report({'INFO'}, "⏳ .blend ファイルを準備中...")
        temp_dir = tempfile.mkdtemp(prefix='gpurental_')
        blend_name = os.path.basename(bpy.data.filepath) if bpy.data.filepath else 'untitled.blend'
        if not blend_name.endswith('.blend'):
            blend_name += '.blend'
        temp_blend = os.path.join(temp_dir, blend_name)
        try:
            bpy.ops.file.pack_all()
        except:
            pass
        bpy.ops.wm.save_as_mainfile(filepath=temp_blend, copy=True)
        with open(temp_blend, 'rb') as f:
            blend_data = f.read()
        file_size_mb = len(blend_data) / (1024 * 1024)

        settings = {
            'gpu_id': gpu_id,
            'job_name': gr.job_name or blend_name.replace('.blend', ''),
            'engine': gr.render_engine,
            'device': gr.render_device,
            'resolution_x': gr.resolution_x if gr.use_custom_resolution else scene.render.resolution_x,
            'resolution_y': gr.resolution_y if gr.use_custom_resolution else scene.render.resolution_y,
            'samples': gr.samples if gr.use_custom_samples else (
                scene.cycles.samples if scene.render.engine == 'CYCLES' else 64
            ),
            'output_format': gr.output_format,
            'frame_start': gr.frame_start if gr.use_custom_frames else scene.frame_start,
            'frame_end': gr.frame_end if gr.use_custom_frames else scene.frame_end,
        }

        # スレッドでアップロード（UIをブロックしない）
        token = prefs.auth_token
        _upload_state.update({'running': True, 'done': False, 'error': None,
                               'result': None, 'message': f'⏳ アップロード中... ({file_size_mb:.1f} MB)'})

        def _upload_worker():
            try:
                result = api_request('POST', '/render-gpu', token=token,
                                     data=settings, files={'file': (blend_name, blend_data)})
                _upload_state['result'] = result
                if 'error' in result:
                    _upload_state['error'] = result['error']
                    _upload_state['message'] = f'❌ {result["error"]}'
                else:
                    job = result.get('job', {})
                    _upload_state['message'] = (
                        f'✅ ジョブ #{job.get("id")} 開始 '
                        f'({job.get("gpu_name","?")} / 見積: {job.get("estimated_cost",0)}pt)'
                    )
            except Exception as e:
                _upload_state['error'] = str(e)
                _upload_state['message'] = f'❌ エラー: {e}'
            finally:
                _upload_state['running'] = False
                _upload_state['done']    = True
                try:
                    os.remove(temp_blend)
                    os.rmdir(temp_dir)
                except:
                    pass

        threading.Thread(target=_upload_worker, daemon=True).start()

        def _check_result():
            if _upload_state['running']:
                return 2.0
            global _user_balance
            if _upload_state.get('result') and not _upload_state['error']:
                _user_balance = _upload_state['result'].get('balance_after', _user_balance)
                start_progress_polling(token)
            return None

        bpy.app.timers.register(_check_result, first_interval=2.0)
        self.report({'INFO'},
            f'⏳ アップロード開始 ({file_size_mb:.1f} MB) — 「GPU選択」パネルのステータスで完了を確認してください')
        return {'FINISHED'}


# ── セッション維持 Operator ────────────────────────────────────────────────────
class GPURENTAL_OT_ToggleKeepAlive(bpy.types.Operator):
    bl_idname = "gpurental.toggle_keep_alive"
    bl_label   = "セッション維持"
    bl_description = "Blender使用中にGPU予約を自動続行。ハートビートを1分ごとに送信し、残り時間を2分未満になれば警告"

    def execute(self, context):
        global _session_keep_alive, _session_remaining_min, _session_gpu_name
        global _session_end_jst, _session_warn, _session_can_extend

        prefs = context.preferences.addons[__name__].preferences
        if not prefs.auth_token:
            self.report({'ERROR'}, "先にログインしてください")
            return {'CANCELLED'}

        if _session_keep_alive:
            # 停止
            _session_keep_alive = False
            self.report({'INFO'}, "⏹ セッション維持を停止しました")
            return {'FINISHED'}

        # 開始: まずハートビートで確認
        token = prefs.auth_token
        result = api_request('POST', '/heartbeat', token=token)
        if result.get('active'):
            _session_keep_alive = True
            _session_remaining_min = result.get('remaining_minutes', -1)
            _session_gpu_name = result.get('gpu_name', '')
            _session_end_jst = result.get('end_time_jst', '')
            _session_warn = result.get('warn_expiry', False)
            _session_can_extend = result.get('can_extend', False)

            # 60秒ごとにハートビート
            def _hb():
                global _session_remaining_min, _session_gpu_name
                global _session_end_jst, _session_warn, _session_can_extend
                if not _session_keep_alive:
                    return None  # 登録解除
                r = api_request('POST', '/heartbeat', token=token)
                if r.get('active'):
                    _session_remaining_min = r.get('remaining_minutes', -1)
                    _session_gpu_name = r.get('gpu_name', '')
                    _session_end_jst = r.get('end_time_jst', '')
                    _session_warn = r.get('warn_expiry', False)
                    _session_can_extend = r.get('can_extend', False)
                else:
                    _session_remaining_min = 0
                return 60.0  # 60秒後に再実行

            if not bpy.app.timers.is_registered(_hb):
                bpy.app.timers.register(_hb, first_interval=60.0, persistent=True)

            self.report({'INFO'},
                f'▶ セッション維持開始: {_session_gpu_name} '
                f'/ 残り {_session_remaining_min}分')
        else:
            self.report({'WARNING'},
                result.get('message', '有効な予約がありません。ポータルで予約してください。'))
        return {'FINISHED'}


class GPURENTAL_OT_ExtendSession(bpy.types.Operator):
    bl_idname = "gpurental.extend_session"
    bl_label  = "+1h 延長"
    bl_description = "現在のGPU予約をポイントを消費し1時間延長する"

    def execute(self, context):
        global _session_remaining_min, _session_end_jst, _user_balance
        prefs = context.preferences.addons[__name__].preferences
        if not prefs.auth_token:
            self.report({'ERROR'}, "先にログインしてください")
            return {'CANCELLED'}
        result = api_request('POST', '/extend', token=prefs.auth_token, data={'hours': 1})
        if 'error' in result:
            self.report({'ERROR'}, result['error'])
            return {'CANCELLED'}
        _session_remaining_min = result.get('remaining_minutes', _session_remaining_min)
        _session_end_jst = result.get('new_end_time_jst', _session_end_jst)
        _user_balance = result.get('balance_after', _user_balance)
        self.report({'INFO'}, result.get('message', '予約を延長しました'))
        return {'FINISHED'}


class GPURENTAL_OT_RefreshJobs(bpy.types.Operator):
    bl_idname = "gpurental.refresh_jobs"
    bl_label = "ジョブ一覧を更新"
    
    def execute(self, context):
        global _active_jobs
        prefs = context.preferences.addons[__name__].preferences
        if not prefs.auth_token:
            return {'CANCELLED'}
        result = api_request('GET', '/jobs', token=prefs.auth_token)
        if isinstance(result, list):
            _active_jobs = result
            self.report({'INFO'}, f"📋 {len(result)}件のジョブを取得")
        return {'FINISHED'}


class GPURENTAL_OT_CancelJob(bpy.types.Operator):
    bl_idname = "gpurental.cancel_job"
    bl_label = "ジョブをキャンセル"
    job_id: IntProperty()
    
    def execute(self, context):
        prefs = context.preferences.addons[__name__].preferences
        result = api_request('POST', f'/jobs/{self.job_id}/cancel', token=prefs.auth_token)
        if 'error' in result:
            self.report({'ERROR'}, result['error'])
            return {'CANCELLED'}
        self.report({'INFO'}, f"✅ ジョブ #{self.job_id} をキャンセルしました")
        bpy.ops.gpurental.refresh_jobs()
        return {'FINISHED'}


class GPURENTAL_OT_DownloadResult(bpy.types.Operator):
    bl_idname = "gpurental.download_result"
    bl_label = "レンダリング結果をダウンロード"
    job_id: IntProperty()
    directory: StringProperty(subtype='DIR_PATH')
    
    def invoke(self, context, event):
        context.window_manager.fileselect_add(self)
        return {'RUNNING_MODAL'}
    
    def execute(self, context):
        prefs = context.preferences.addons[__name__].preferences
        base_url = prefs.server_url.rstrip('/')
        save_dir = self.directory or tempfile.gettempdir()
        zip_path = os.path.join(save_dir, f'gpurental_render_{self.job_id}.zip')
        url = f"{base_url}/api/blender/jobs/{self.job_id}/download"
        
        self.report({'INFO'}, f"⏳ ダウンロード中...")
        success = download_file(url, prefs.auth_token, zip_path)
        
        if success:
            self.report({'INFO'}, f"✅ ダウンロード完了: {zip_path}")
            try:
                import zipfile
                extract_dir = os.path.join(save_dir, f'gpurental_render_{self.job_id}')
                with zipfile.ZipFile(zip_path, 'r') as z:
                    z.extractall(extract_dir)
                for f in os.listdir(extract_dir):
                    if f.lower().endswith(('.png', '.jpg', '.jpeg', '.exr')):
                        img = bpy.data.images.load(os.path.join(extract_dir, f))
                        for area in context.screen.areas:
                            if area.type == 'IMAGE_EDITOR':
                                area.spaces.active.image = img
                                break
                        self.report({'INFO'}, f"🖼 画像をロード: {f}")
                        break
            except Exception as e:
                self.report({'WARNING'}, f"ZIP展開エラー: {e}")
        else:
            self.report({'ERROR'}, "ダウンロードに失敗しました")
            return {'CANCELLED'}
        return {'FINISHED'}


# ── Progress Polling ─────────────────────────────────────────────────────────
def start_progress_polling(token):
    global _polling_thread, _polling_active
    if _polling_active:
        return
    _polling_active = True
    def poll_worker():
        global _active_jobs, _polling_active
        while _polling_active:
            result = api_request('GET', '/jobs', token=token)
            if isinstance(result, list):
                _active_jobs = result
                has_active = any(j.get('status') in ('queued', 'rendering') for j in result)
                if not has_active:
                    _polling_active = False
                    break
            time.sleep(3)
    _polling_thread = threading.Thread(target=poll_worker, daemon=True)
    _polling_thread.start()


# ── Scene Properties ─────────────────────────────────────────────────────────
class GPURentalProperties(bpy.types.PropertyGroup):
    job_name: StringProperty(name="ジョブ名", default="")
    
    selected_gpu: EnumProperty(
        name="GPU",
        description="レンダリングに使用するGPU",
        items=get_gpu_items,
    )
    
    render_engine: EnumProperty(
        name="エンジン",
        items=[('CYCLES', 'Cycles', 'パストレーシング（高品質）'),
               ('EEVEE', 'Eevee', 'リアルタイム（高速）')],
        default='CYCLES',
    )
    render_device: EnumProperty(
        name="デバイス",
        items=[('GPU', 'GPU', 'GPUレンダリング（推奨）'),
               ('CPU', 'CPU', 'CPUレンダリング')],
        default='GPU',
    )
    output_format: EnumProperty(
        name="出力形式",
        items=[('PNG', 'PNG', '可逆圧縮（推奨）'),
               ('JPEG', 'JPEG', '非可逆圧縮'),
               ('OPEN_EXR', 'OpenEXR', 'HDR形式（合成向け）'),
               ('BMP', 'BMP', '無圧縮')],
        default='PNG',
    )
    use_custom_resolution: BoolProperty(name="解像度を指定", default=False)
    resolution_x: IntProperty(name="X", default=1920, min=1, max=7680)
    resolution_y: IntProperty(name="Y", default=1080, min=1, max=4320)
    use_custom_samples: BoolProperty(name="サンプル数を指定", default=False)
    samples: IntProperty(name="サンプル数", default=128, min=1, max=4096)
    use_custom_frames: BoolProperty(name="フレーム範囲を指定", default=False)
    frame_start: IntProperty(name="開始", default=1, min=1)
    frame_end: IntProperty(name="終了", default=250, min=1)
    show_tips: BoolProperty(
        name="使い方ガイド",
        description="「仕組みとべストプラクティス」を表示",
        default=False
    )


# ── UI Panel: サービスの仕組みガイド ──────────────────────────────
# 「GPURental」タブ内に「仕組み」サブパネルを追加
class GPURENTAL_PT_HowItWorks(bpy.types.Panel):
    bl_label = "ℹ サービスの仕組みと使い方"
    bl_idname = "GPURENTAL_PT_how_it_works"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = "GPURental"
    bl_options = {'DEFAULT_CLOSED'}  # デフォルトで折りたたみ

    def draw(self, context):
        layout = self.layout

        # ── サービスの仕組み
        box = layout.box()
        box.label(text="📦 レンダーファーム方式です", icon='INFO')
        col = box.column(align=True)
        col.scale_y = 0.85
        col.label(text="ブレンダーの『最終レンダリング』だけをクラウド即GPUで実行")
        col.label(text="→ ビューポートのリアルタイム描画は手元プレビューーは手元PC")
        col.label(text="→ GeForce NOWやクラウドPCとは異なります")

        layout.separator(factor=0.5)

        # ── ベストプラクティス
        box2 = layout.box()
        box2.label(text="✅ おすすめの使い方", icon='CHECKMARK')
        col2 = box2.column(align=True)
        col2.scale_y = 0.85

        tips = [
            ("🖥 作業中はSolidモードで作業",
             "   Renderedプレビューは手元PCがフルロードに"),
            ("⚙️ 問题なければライトプリビューでOK",
             "   Viewportシェーディングやアンビエントオクルージ〈7使用"),
            ("☁ 後処理（最終レンダリング）はクラウドへ",
             "   高解像度・高サンプルの重い処理をクラウドGPUが実行"),
            ("🔄 アニメーションワークフロー",
             "   レンダリング中に次のシーンの作業を続けられる"),
        ]
        for title, desc in tips:
            col2.label(text=title)
            col2.label(text=desc)

        layout.separator(factor=0.5)

        # ── 機能比較表
        box3 = layout.box()
        box3.label(text="📊 GeForce NOW vs GPURental", icon='QUESTION')
        compare = layout.column(align=True)
        compare.scale_y = 0.8
        rows = [
            ("機能            GeForceNOW    GPURental"),
            ("───────────────────────────"),
            ("ビューポート描画       ☁ クラウド  🖥 手元PC"),
            ("最終レンダリング     ☁ クラウド  ☁ クラウド"),
            ("定額料金         ✓ 必要    ✗ 使った分だけ"),
            ("アドオン連携         ✗ なし    ✓ Blender直結"),
        ]
        for r in rows:
            compare.label(text=r)

        layout.separator(factor=0.5)
        box4 = layout.box()
        box4.label(text="🔗 詳細ガイド: gpurental.jp/docs/blender")



# ── UI Panel ─────────────────────────────────────────────────────────────────
class GPURENTAL_PT_MainPanel(bpy.types.Panel):
    bl_label = "GPURental Cloud Render"
    bl_idname = "GPURENTAL_PT_main"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = "GPURental"
    
    def draw(self, context):
        layout = self.layout
        prefs = context.preferences.addons[__name__].preferences
        scene = context.scene
        gr = scene.gpurental
        
        # ── Login ──
        box = layout.box()
        if prefs.auth_token:
            row = box.row()
            row.label(text="🟢 ログイン済み", icon='CHECKMARK')
            row.operator("gpurental.check_status", text="", icon='FILE_REFRESH')
        else:
            box.label(text="🔒 未ログイン", icon='LOCKED')
            box.prop(prefs, "email")
            box.prop(prefs, "password")
            box.operator("gpurental.login", icon='CHECKMARK')
            return
        
        layout.separator()
        
        # ── Balance & GPU Selection ──
        box = layout.box()
        header = box.row()
        # icon='GPU' は Blender 5.x で無効 → 'DESKTOP' を使用
        header.label(text="\U0001f3ae GPU\u9078\u629e", icon='DESKTOP')
        header.operator("gpurental.fetch_gpus", text="\u66f4\u65b0", icon='FILE_REFRESH')

        # 残高表示（APIから文字列で返ることがあるため安全にキャスト）
        try:
            balance_int = int(float(_user_balance))
        except (TypeError, ValueError):
            balance_int = 0
        bal_row = box.row()
        bal_row.alert = balance_int < 100
        bal_row.label(text=f"\U0001f4b0 \u30dd\u30a4\u30f3\u30c8\u6b8b\u9ad8: {balance_int:,} pt", icon='FUND')

        # アクティブセッション表示
        if _active_session:
            sess_box = box.box()
            sess_box.label(text=f"\u26a1 \u30a2\u30af\u30c6\u30a3\u30d6\u30bb\u30c3\u30b7\u30e7\u30f3: {_active_session['gpu_name']}", icon='LINKED')
            sess_box.label(text=f"   \u00a5{_active_session['price_per_hour']}/h | \u6709\u52b9\u671f\u9650: {_active_session.get('expires', 'N/A')}")

        # 予約済みGPUがある場合 → ドロップダウン表示
        if _gpu_list or _active_session:
            box.prop(gr, "selected_gpu", text="")

            # コスト見積り
            gpu_id = int(gr.selected_gpu) if gr.selected_gpu and gr.selected_gpu != '0' else 0
            if gpu_id > 0:
                selected_info = None
                for g in _gpu_list:
                    if g['id'] == gpu_id:
                        selected_info = g
                        break
                if _active_session and _active_session.get('gpu_id') == gpu_id:
                    selected_info = _active_session

                if selected_info:
                    price = selected_info.get('price_per_hour', 0)
                    fs = gr.frame_start if gr.use_custom_frames else scene.frame_start
                    fe = gr.frame_end if gr.use_custom_frames else scene.frame_end
                    n_frames = max(1, fe - fs + 1)
                    est_min = max(1, n_frames * 10 // 60)
                    est_cost = max(price, int(price * est_min / 60))

                    info = box.column(align=True)
                    info.label(text=f"\U0001f4ca \u898b\u7a4d\u308a: \u7d04 {est_cost:,} pt ({est_min}\u5206\u7a0b\u5ea6)")
                    if est_cost > balance_int:
                        warn = info.row()
                        warn.alert = True
                        warn.label(text=f"\u26a0 \u30dd\u30a4\u30f3\u30c8\u4e0d\u8db3 (\u6b8b\u9ad8 {balance_int:,} pt)", icon='ERROR')

        else:
            # 予約がない場合 → 予約誘導UI
            warn_box = box.box()
            warn_box.alert = True
            warn_box.label(text="\u26a0 \u30af\u30e9\u30a6\u30c9\u30ec\u30f3\u30c0\u30ea\u30f3\u30b0\u306b\u306fGPU\u306e\u4e88\u7d04\u304c\u5fc5\u8981\u3067\u3059", icon='ERROR')
            if _no_reservation_msg:
                for line in _no_reservation_msg.split('\n'):
                    warn_box.label(text=line)

            # 予約可能GPU一覧（参考表示）
            if _available_to_book:
                avail_box = box.box()
                avail_box.label(text="\U0001f4cb \u4e88\u7d04\u53ef\u80fdGPU\u4e00\u89a7:", icon='INFO')
                for g in _available_to_book[:5]:
                    avail_box.label(text=f"  \u2022 {g['name']} ({g.get('vram_gb','?')}GB) \u2014 \u00a5{g['price_per_hour']}/h")
                avail_box.label(text="\u2935 gpurental.jp/portal/ \u3067\u4e88\u7d04\u3057\u3066\u304f\u3060\u3055\u3044")

            gpu_id = 0  # 送信無効化用

        layout.separator()
        
        # ── Render Settings ──
        box = layout.box()
        box.label(text="⚙ レンダリング設定", icon='SETTINGS')
        box.prop(gr, "job_name")
        
        row = box.row()
        row.prop(gr, "render_engine", expand=True)
        row = box.row()
        row.prop(gr, "render_device", expand=True)
        box.prop(gr, "output_format")
        
        # Resolution
        row = box.row()
        row.prop(gr, "use_custom_resolution")
        if gr.use_custom_resolution:
            sub = box.row(align=True)
            sub.prop(gr, "resolution_x")
            sub.prop(gr, "resolution_y")
        else:
            box.label(text=f"現在: {scene.render.resolution_x} x {scene.render.resolution_y}")
        
        # Samples
        row = box.row()
        row.prop(gr, "use_custom_samples")
        if gr.use_custom_samples:
            box.prop(gr, "samples")
        else:
            if scene.render.engine == 'CYCLES':
                box.label(text=f"現在: {scene.cycles.samples} サンプル")
        
        # Frames
        row = box.row()
        row.prop(gr, "use_custom_frames")
        if gr.use_custom_frames:
            sub = box.row(align=True)
            sub.prop(gr, "frame_start")
            sub.prop(gr, "frame_end")
        else:
            box.label(text=f"現在: {scene.frame_start} - {scene.frame_end}")
        
        layout.separator()

        # ── アップロードステータス表示 ──
        if _upload_state['running']:
            status_box = layout.box()
            status_box.alert = False
            status_box.label(text=_upload_state.get('message', '⏳ アップロード中...'), icon='SORTTIME')
        elif _upload_state['done'] and _upload_state.get('message'):
            status_box = layout.box()
            status_box.alert = bool(_upload_state.get('error'))
            status_box.label(text=_upload_state['message'],
                             icon='ERROR' if _upload_state.get('error') else 'CHECKMARK')

        # ── 送信ボタン ──
        row = layout.row(align=True)
        row.scale_y = 2.0
        if _upload_state['running']:
            # アップロード中はボタンをグレーアウト
            row.enabled = False
            row.operator("gpurental.submit_render",
                text="⏳ アップロード中...",
                icon='SORTTIME')
        else:
            row.enabled = (gpu_id > 0 and balance_int > 0)
            row.operator("gpurental.submit_render",
                text="☁ クラウドレンダリング開始",
                icon='RENDER_STILL')

        layout.separator()

        # ── セッション管理ボックス ──
        sess_box = layout.box()
        sess_hdr = sess_box.row()
        keep_icon = 'CHECKBOX_HLT' if _session_keep_alive else 'CHECKBOX_DEHLT'
        sess_hdr.label(text="⏰ GPUセッション維持", icon='LINKED')
        sess_hdr.operator(
            "gpurental.toggle_keep_alive",
            text="停止" if _session_keep_alive else "開始",
            icon=keep_icon,
            depress=_session_keep_alive,   # ON時はボタンを押し込み状態に
        )

        if _session_keep_alive:
            # 残り時間表示
            info_col = sess_box.column(align=True)
            info_col.scale_y = 0.85
            if _session_remaining_min >= 0:
                if _session_warn:
                    warn_row = info_col.row()
                    warn_row.alert = True
                    warn_row.label(
                        text=f"⚠ 残り {_session_remaining_min}分 — 間もなく切れます！",
                        icon='ERROR')
                else:
                    h, m = divmod(_session_remaining_min, 60)
                    remain_str = f"{h}時間{m}分" if h else f"{m}分"
                    info_col.label(
                        text=f"✅ {_session_gpu_name} | 残り {remain_str}")
                info_col.label(
                    text=f"   終了予定: {_session_end_jst}")
            else:
                info_col.label(text="取得中...", icon='SORTTIME')

            # 延長ボタン
            ext_row = sess_box.row()
            ext_row.enabled = _session_can_extend
            ext_row.operator("gpurental.extend_session",
                              text="+1h 延長 (ポイント消費)",
                              icon='ADD')
            if not _session_can_extend:
                sess_box.label(text="⚠ ポイント不足のため延長できません", icon='ERROR')
        else:
            sess_box.label(
                text="「開始」ボタンでセッションを維持します",
                icon='INFO')

        # ── Jobs List ──
        box = layout.box()
        header = box.row()
        header.label(text="📋 レンダリングジョブ", icon='RENDER_RESULT')
        header.operator("gpurental.refresh_jobs", text="", icon='FILE_REFRESH')
        
        if not _active_jobs:
            box.label(text="ジョブはありません")
        else:
            for job in _active_jobs[:10]:
                job_box = box.box()
                row = job_box.row()
                status_icon = {
                    'queued': '⏳', 'rendering': '🔄',
                    'completed': '✅', 'failed': '❌', 'cancelled': '🚫',
                }.get(job.get('status'), '❓')
                row.label(text=f"{status_icon} #{job.get('id')} {job.get('job_name', '?')}")
                
                if job.get('status') == 'rendering':
                    progress = job.get('progress', 0) / 100
                    job_box.progress(text=f"{job.get('progress', 0)}%", factor=progress, type='BAR')
                    job_box.label(text=f"フレーム {job.get('current_frame', 0)}/{job.get('total_frames', 1)}")
                
                info = f"{job.get('render_engine', '')} | {job.get('resolution_x', 0)}x{job.get('resolution_y', 0)}"
                if job.get('render_time'):
                    mins = job['render_time'] // 60
                    secs = job['render_time'] % 60
                    info += f" | {mins}分{secs}秒"
                job_box.label(text=info)
                
                row = job_box.row(align=True)
                if job.get('status') in ('queued', 'rendering'):
                    op = row.operator("gpurental.cancel_job", text="キャンセル", icon='CANCEL')
                    op.job_id = job.get('id')
                elif job.get('status') == 'completed':
                    op = row.operator("gpurental.download_result", text="ダウンロード", icon='IMPORT')
                    op.job_id = job.get('id')
                elif job.get('status') == 'failed':
                    error = job.get('error_log', '')
                    if error:
                        job_box.label(text=f"エラー: {error[:60]}...")


# ── Registration ─────────────────────────────────────────────────────────────
classes = (
    GPURentalPreferences,
    GPURentalProperties,
    GPURENTAL_OT_MCP_Toggle,
    GPURENTAL_OT_Login,
    GPURENTAL_OT_CheckStatus,
    GPURENTAL_OT_FetchGPUs,
    GPURENTAL_OT_SubmitRender,
    GPURENTAL_OT_ToggleKeepAlive,
    GPURENTAL_OT_ExtendSession,
    GPURENTAL_OT_RefreshJobs,
    GPURENTAL_OT_CancelJob,
    GPURENTAL_OT_DownloadResult,
    GPURENTAL_PT_HowItWorks,   # 「仕組みと使い方」サブパネル
    GPURENTAL_PT_MainPanel,
)

def register():
    for cls in classes:
        bpy.utils.register_class(cls)
    bpy.types.Scene.gpurental = bpy.props.PointerProperty(type=GPURentalProperties)

def unregister():
    global _polling_active, _session_keep_alive
    _polling_active = False
    _session_keep_alive = False  # ハートビートタイマーを止める
    
    if blender_mcp_server and blender_mcp_server.is_running():
        blender_mcp_server.stop_server()
        
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)
    del bpy.types.Scene.gpurental

if __name__ == "__main__":
    register()
