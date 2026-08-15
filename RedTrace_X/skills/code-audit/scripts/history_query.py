#!/usr/bin/env python3
"""
历史告警 API 查询脚本

所属模式: sast-audit
用途: 查询 CodeQL/SAST 历史告警记录，用于告警研判时的历史上下文参考
数据源: 安全平台 API (非本地数据库)
"""

import argparse
import json
import os
import sys
import time
from typing import Any

import requests

# API 配置
API_URL = (
    "https://security-api-manage-v2.corp.kuaishou.com/api/v1/get_security_issue_list"
)
API_TOKEN = os.environ.get("API_MANAGE_TOKEN", "")
PAGE_SIZE = 10
TIMEOUT = 30


# 反向映射：核心类型 -> 原始类型列表
VUL_TYPE_MAP = {
    "sql注入": [
        "go_sql_injection",
        "go-sqlinjection",
        "java-mybatisannotationsqlinjection",
        "java-mybatisxmlsqlinjection",
        "java-sqlinjection",
        "nodejs-sqlinjection",
        "Python_SQL_Injection",
        "python-sql-injection",
        "SQL_Injection_JDBC",
        "SQL_Injection_Mybatis",
        "SQL_Injection_Mybatisplus",
        "SQL_Injection_ReportService",
    ],
    "SSRF": [
        "go_ssrf",
        "go-ssrf",
        "java-ssrf",
        "NodeJS_SSRF",
        "nodejs-ssrf",
        "SSRF",
        "SSRF_new",
        "py/ssrf",
    ],
    "远程命令执行": [
        "Command_Injection",
        "go_cmd_injection",
        "go-commandinjection",
        "java-commandinjection",
        "nodejs-commandinjection",
        "py_Command_Injection",
        "py/code-injection",
    ],
    "任意代码执行": [
        "Code_Injection",
        "Expression_Language_Injection_OGNL",
        "hibernate_validate_EL",
        "QLExpress",
    ],
    "任意文件读取": [
        "py_pathTraversal",
        "PyPathTraverse",
        "Absolute_Path_Traversal",
    ],
    "文件上传未接入管控": [
        "FileUpload",
        "FileUpload_Cloud",
        "PyFileUpload",
    ],
    "任意文件上传(ContentType可控)": [
        "set_MIME",
    ],
    "反射型XSS(下载ContentType非法)": [
        "java-FileWriteToResp",
    ],
    "xml外部实体注入漏洞XXE": [
        "java-xxe",
        "py/xxe",
        "PyXXE",
        "XXE_ALL",
        "XXE_DocumentBuilder",
        "XXE_SAXParserFactory",
        "XXE_SAXReader",
        "XXE_TransformerFactory",
        "XXE_Unmarshaller",
    ],
    "URL重定向/任意跳转": [
        "Open_Redirect",
        "OpenRedirect_new",
    ],
    "不安全的反序列化": [
        "java/unsafe-deserialization",
        "py/unsafe-deserialization",
        "Unsafe_Deserialization",
    ],
    "CORS": [
        "CORS",
        "java/unvalidated-cors-origin-set",
        "js/cors-misconfiguration-for-credentials",
    ],
    "反射型XSS": [
        "js/react-xss-dom",
        "js/vue-xss-dom",
        "js/xss-postmessage",
    ],
    "隐私视频漏洞": [
        "private_video",
        "private_video_grpc",
        "Private_Video_Leak",
    ],
    "私密账号漏洞": [
        "private_account",
    ],
    "Swagger的不安全使用": [
        "js/swagger",
        "swagger",
    ],
    "配置缺陷": [
        "Python_web_enable_debug",
    ],
    "SPEL表达式命令执行": [
        "Expression_Language_Injection_SPEL",
    ],
}

# 运行时构建正向查询字典：原始类型 -> 核心类型
RAW_VUL_TYPE_MAP = {}
for vul_type, raw_types in VUL_TYPE_MAP.items():
    for raw in raw_types:
        RAW_VUL_TYPE_MAP[raw] = vul_type


def get_mapped_vul_type(raw_vul_type: str) -> str:
    """获取映射后的漏洞类型，未映射则返回原始值"""
    return RAW_VUL_TYPE_MAP.get(raw_vul_type, raw_vul_type)


# 需要排除的非代码原因模式
EXCLUDE_PATTERNS = [
    "测试",
    "test",
    "个人自测代码",
    "废弃仓库",
    "服务已下线",
    "历史分支",
    "工单合并",
    "合并工单",
    "重复工单",
    "对内业务",
    "工程侧已兜住",
    "不会发布到线上",
    "大模型自动运营",
    "不存在",
]


def should_exclude(record: dict[str, Any]) -> bool:
    """过滤非代码原因记录"""
    value = record.get("comment", "")
    if value and value != "nan":
        value_lower = str(value).lower()
        for pattern in EXCLUDE_PATTERNS:
            if pattern.lower() in value_lower:
                return True
    return False


def query_api(
    git_address: str,
    vul_type: str = None,
    raw_vul_type: str = None,
    file_path: str = None,
) -> list[dict]:
    """
    分页循环查询 API，返回所有记录

    注意：API 的 vul_type 和 raw_vul_type 是 AND 逻辑，因此必须单独传其中一个
    """
    if not API_TOKEN:
        print("错误: 未设置环境变量 API_MANAGE_TOKEN", file=sys.stderr)
        return []

    all_records = []
    page_number = 1

    while True:
        params = {
            "git_address": git_address,
            "page_number": page_number,
            "page_size": PAGE_SIZE,
        }
        if vul_type:
            params["vul_type"] = vul_type
        if raw_vul_type:
            params["raw_vul_type"] = raw_vul_type
        if file_path:
            params["file_path"] = file_path

        headers = {
            "Authorization": f"Bearer {API_TOKEN}",
            "Content-Type": "application/json",
        }

        try:
            response = requests.get(
                API_URL, params=params, headers=headers, timeout=TIMEOUT
            )
            response.raise_for_status()
            data = response.json()

            # 兼容两种响应格式：{"data": {"list": [...]}} 或 {"data": [...]}
            data_field = data.get("data")
            if isinstance(data_field, list):
                records = data_field
            elif isinstance(data_field, dict):
                records = data_field.get("list", [])
            else:
                records = []
            if not records:
                break

            all_records.extend(records)

            # 当返回数据少于 page_size 时停止循环
            if len(records) < PAGE_SIZE:
                break

            page_number += 1
            time.sleep(1)

        except requests.exceptions.RequestException as e:
            print(f"API 请求失败: {e}", file=sys.stderr)
            break
        except Exception as e:
            print(f"解析响应失败: {e}", file=sys.stderr)
            break

    return all_records


def process_records(records: list[dict]) -> tuple[list[dict], list[dict]]:
    """
    过滤并分组记录

    返回: (漏洞列表, 安全列表)
    """
    filtered = [
        r for r in records if not should_exclude(r) and r.get("issue_status") in (1, 2)
    ]
    vuln = [r for r in filtered if r.get("issue_status") == 1]
    safe = [r for r in filtered if r.get("issue_status") == 2]
    return vuln, safe


def format_records(valid: list[dict], invalid: list[dict]) -> list[dict]:
    """格式化记录输出"""
    result = []
    for r in valid + invalid:
        comment = r.get("comment", "") or ""
        result.append(
            {
                "文件": os.path.basename(r.get("file_path", "")),
                "备注": [comment] if comment else [],
            }
        )
    return result


def main():
    parser = argparse.ArgumentParser(description="查询历史告警 API")
    parser.add_argument("--git_address", required=True, help="Git仓库地址")
    parser.add_argument("--raw_vul_type", required=True, help="原始漏洞类型")
    parser.add_argument("--file_path", required=True, help="文件路径")

    args = parser.parse_args()

    raw_vul_type = args.raw_vul_type
    vul_type = get_mapped_vul_type(raw_vul_type)

    # 四级降级查询，两级输出
    exact_records = []
    project_records = []

    # 1. 精确匹配（vul_type）：git_address + vul_type + file_path
    if vul_type != raw_vul_type:
        exact_records = query_api(
            args.git_address, vul_type=vul_type, file_path=args.file_path
        )

    # 2. 精确匹配（raw_vul_type）：git_address + raw_vul_type + file_path
    if not exact_records:
        exact_records = query_api(
            args.git_address, raw_vul_type=raw_vul_type, file_path=args.file_path
        )

    # 3. 项目级匹配（vul_type）：git_address + vul_type
    if not exact_records and vul_type != raw_vul_type:
        project_records = query_api(args.git_address, vul_type=vul_type)

    # 4. 项目级匹配（raw_vul_type）：git_address + raw_vul_type
    if not exact_records and not project_records:
        project_records = query_api(args.git_address, raw_vul_type=raw_vul_type)

    # 处理记录
    exact_vuln, exact_safe = process_records(exact_records)
    project_vuln, project_safe = process_records(project_records)

    # 输出中文结果
    print(
        json.dumps(
            {
                "找到记录": bool(exact_records or project_records),
                "精确匹配": {
                    "漏洞数": len(exact_vuln),
                    "安全数": len(exact_safe),
                    "记录": format_records(exact_vuln, exact_safe),
                },
                "项目级匹配": {
                    "漏洞数": len(project_vuln),
                    "安全数": len(project_safe),
                    "记录": format_records(project_vuln, project_safe),
                },
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
