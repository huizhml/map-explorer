#!/usr/bin/env python3
"""
Test script for Sentinel-2 query endpoint
"""
import requests
import json

# Test the Sentinel-2 query endpoint
url = "http://localhost:8000/sentinel2/query"

# Example extent in EPSG:3857 (Web Mercator) - Denmark area
# These coordinates are approximately around Copenhagen, Denmark
extent = [
    1388378.0,  # minX
    7490288.0,  # minY
    1398378.0,  # maxX
    7500288.0,  # maxY
]

# Query for 2024
year = 2024

payload = {
    "extent": extent,
    "year": year
}

print(f"Testing Sentinel-2 query...")
print(f"Extent: {extent}")
print(f"Year: {year}")
print(f"Making POST request to {url}...")

try:
    response = requests.post(url, json=payload, timeout=30)
    print(f"\nStatus Code: {response.status_code}")
    
    if response.status_code == 200:
        data = response.json()
        print("\nResponse:")
        print(json.dumps(data, indent=2))
        
        if data.get('success'):
            print(f"\n✅ Success! Found {data.get('count', 0)} images")
            
            if data.get('images'):
                print("\nFirst 3 images:")
                for i, img in enumerate(data['images'][:3], 1):
                    print(f"\n{i}. ID: {img.get('id')}")
                    print(f"   Date: {img.get('datetime')}")
                    print(f"   Cloud Cover: {img.get('cloud_cover')}%")
                    print(f"   Platform: {img.get('platform')}")
        else:
            print(f"\n❌ Error: {data.get('error')}")
    else:
        print(f"\n❌ HTTP Error {response.status_code}")
        print(response.text)
        
except requests.exceptions.ConnectionError:
    print("\n❌ Connection Error: Is the backend running on http://localhost:8000?")
except requests.exceptions.Timeout:
    print("\n❌ Timeout: Request took too long")
except Exception as e:
    print(f"\n❌ Error: {e}")

