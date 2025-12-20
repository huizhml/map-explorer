#!/usr/bin/env python3
"""
Test script to verify connectivity to Microsoft Planetary Computer STAC API
with detailed network diagnostics
"""
import requests
import json
import socket
import os
import errno

def get_socket_error_message(error_code):
    """Get human-readable message for socket error codes"""
    error_messages = {
        35: "Resource temporarily unavailable (EAGAIN) - Connection refused or blocked by firewall",
        61: "Connection refused (ECONNREFUSED) - Port may be blocked or service unavailable",
        51: "Network is unreachable (ENETUNREACH) - Network routing issue",
        64: "Host is down (EHOSTDOWN) - Server is not responding",
        65: "No route to host (EHOSTUNREACH) - Cannot reach the host",
        113: "No route to host (EHOSTUNREACH) - Network routing problem",
        111: "Connection refused - Port blocked or service down",
    }
    try:
        errno_name = errno.errorcode.get(error_code, f"UNKNOWN({error_code})")
    except:
        errno_name = f"ERROR({error_code})"
    
    return error_messages.get(error_code, f"{errno_name}: TCP connection failed (likely firewall/proxy blocking port 443)")

def test_network_diagnostics():
    """Test network layer connectivity"""
    print("\n=== NETWORK DIAGNOSTICS ===")
    host = "planetarycomputer.microsoft.com"
    port = 443
    
    # Check environment variables
    print("\nEnvironment:")
    http_proxy = os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy")
    https_proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    no_proxy = os.environ.get("NO_PROXY") or os.environ.get("no_proxy")
    print(f"  HTTP_PROXY: {http_proxy or 'Not set'}")
    print(f"  HTTPS_PROXY: {https_proxy or 'Not set'}")
    print(f"  NO_PROXY: {no_proxy or 'Not set'}")
    
    # Test DNS resolution
    print(f"\n1. DNS Resolution ({host}):")
    try:
        ip_address = socket.gethostbyname(host)
        print(f"   ✓ Resolved to: {ip_address}")
    except socket.gaierror as e:
        print(f"   ✗ DNS resolution failed: {str(e)}")
        print(f"   → Check your DNS settings or internet connection")
        return False
    except Exception as e:
        print(f"   ✗ Error: {type(e).__name__}: {str(e)}")
        return False
    
    # Test TCP connection
    print(f"\n2. TCP Connection ({host}:{port}):")
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5)
        result = sock.connect_ex((host, port))
        sock.close()
        if result == 0:
            print(f"   ✓ TCP connection successful")
        else:
            error_msg = get_socket_error_message(result)
            print(f"   ✗ TCP connection failed: {error_msg}")
            print(f"\n   Possible solutions:")
            if result == 35:
                print(f"   1. Check firewall settings - port 443 (HTTPS) is likely blocked")
                print(f"   2. If on corporate network, contact IT to allow connections to")
                print(f"      planetarycomputer.microsoft.com")
                print(f"   3. Try disabling VPN temporarily to test")
                print(f"   4. Configure proxy settings if required by your network")
            else:
                print(f"   1. Check firewall settings for port 443 (HTTPS)")
                print(f"   2. Verify network connectivity and routing")
                print(f"   3. Check proxy/VPN configuration")
            return False
    except socket.timeout:
        print(f"   ✗ TCP connection timeout")
        print(f"   → Possible causes: Firewall, proxy, or network restrictions")
        return False
    except Exception as e:
        print(f"   ✗ Error: {type(e).__name__}: {str(e)}")
        return False
    
    print(f"\n3. HTTPS Connection:")
    try:
        stac_url = "https://planetarycomputer.microsoft.com/api/stac/v1"
        response = requests.get(stac_url, timeout=10)
        if response.status_code == 200:
            print(f"   ✓ HTTPS connection successful (Status: {response.status_code})")
            return True
        else:
            print(f"   ⚠ HTTPS returned status {response.status_code}")
            return False
    except requests.exceptions.SSLError as e:
        print(f"   ✗ SSL/TLS error: {str(e)}")
        print(f"   → Possible certificate or SSL configuration issue")
        return False
    except requests.exceptions.ConnectTimeout as e:
        print(f"   ✗ Connection timeout: {str(e)}")
        print(f"   → Server is not responding (might be blocked by firewall/proxy)")
        return False
    except requests.exceptions.ConnectionError as e:
        print(f"   ✗ Connection error: {str(e)}")
        print(f"   → Cannot establish connection to server")
        return False
    except Exception as e:
        print(f"   ✗ Error: {type(e).__name__}: {str(e)}")
        return False

def test_connection():
    print("Testing Microsoft Planetary Computer STAC API connectivity...")
    print("=" * 60)
    
    # Run network diagnostics first
    network_ok = test_network_diagnostics()
    
    if not network_ok:
        print("\n" + "=" * 60)
        print("❌ Network diagnostics failed. Cannot proceed with API tests.")
        print("\nPossible solutions:")
        print("  1. Check firewall settings for port 443 (HTTPS)")
        print("  2. Check VPN/proxy configuration")
        print("  3. Try disabling VPN temporarily")
        print("  4. Check if you're on a corporate network with restrictions")
        print("  5. Verify DNS settings (try 8.8.8.8 or 1.1.1.1)")
        return
    
    print("\n" + "=" * 60)
    print("=== API ENDPOINT TESTS ===")
    
    stac_url = "https://planetarycomputer.microsoft.com/api/stac/v1"
    headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'MapExplorer-Test/1.0'
    }
    
    # Test 1: Base endpoint
    print("\n1. Testing base endpoint...")
    try:
        response = requests.get(stac_url, timeout=10)
        print(f"   Status: {response.status_code}")
        if response.status_code == 200:
            data = response.json()
            print(f"   Response type: {data.get('type', 'unknown')}")
            print(f"   STAC version: {data.get('stac_version', 'unknown')}")
    except Exception as e:
        print(f"   ERROR: {type(e).__name__}: {str(e)}")
    
    # Test 2: Collections endpoint
    print("\n2. Testing collections endpoint...")
    try:
        collections_url = f"{stac_url}/collections"
        response = requests.get(collections_url, timeout=10)
        print(f"   Status: {response.status_code}")
        if response.status_code == 200:
            data = response.json()
            collections = data.get('collections', [])
            print(f"   Found {len(collections)} collections")
            sentinel2_found = any(c.get('id') == 'sentinel-2-l2a' for c in collections)
            print(f"   Sentinel-2-L2A collection: {'Found' if sentinel2_found else 'NOT FOUND'}")
    except Exception as e:
        print(f"   ERROR: {type(e).__name__}: {str(e)}")
    
    # Test 3: Simple search query
    print("\n3. Testing search endpoint (minimal query)...")
    try:
        search_url = f"{stac_url}/search"
        test_params = {
            "collections": ["sentinel-2-l2a"],
            "limit": 1
        }
        response = requests.post(search_url, json=test_params, headers=headers, timeout=30)
        print(f"   Status: {response.status_code}")
        if response.status_code == 200:
            data = response.json()
            features = data.get('features', [])
            print(f"   Found {len(features)} features")
            if features:
                feature = features[0]
                props = feature.get('properties', {})
                print(f"   Sample item ID: {feature.get('id', 'N/A')[:50]}...")
                print(f"   Sample datetime: {props.get('datetime', 'N/A')}")
        else:
            print(f"   Response text: {response.text[:200]}")
    except Exception as e:
        print(f"   ERROR: {type(e).__name__}: {str(e)}")
    
    # Test 4: Tile-based query
    print("\n4. Testing tile-based query (tile: 33UUB)...")
    try:
        search_url = f"{stac_url}/search"
        test_params = {
            "collections": ["sentinel-2-l2a"],
            "query": {"s2:mgrs_tile": {"eq": "33UUB"}},
            "limit": 5
        }
        response = requests.post(search_url, json=test_params, headers=headers, timeout=30)
        print(f"   Status: {response.status_code}")
        if response.status_code == 200:
            data = response.json()
            features = data.get('features', [])
            print(f"   Found {len(features)} features for tile 33UUB")
            if features:
                feature = features[0]
                props = feature.get('properties', {})
                print(f"   Sample datetime: {props.get('datetime', 'N/A')}")
                print(f"   Sample cloud cover: {props.get('eo:cloud_cover', 'N/A')}")
        else:
            print(f"   Response text: {response.text[:200]}")
    except Exception as e:
        print(f"   ERROR: {type(e).__name__}: {str(e)}")
    
    print("\n" + "-" * 60)
    print("Test completed!")

if __name__ == "__main__":
    test_connection()
