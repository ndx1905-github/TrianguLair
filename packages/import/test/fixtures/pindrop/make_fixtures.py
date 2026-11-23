#!/usr/bin/env python3
"""Writes the INVENTED Pin Drop export of the tests (pindrop.json, and invalid.json cut short).

The layout mirrors a real Pin Drop export (T-009): a `data` array mixing "tag", "pin" and
"message" items, plus `users`, `org`, `largeNumberOfPins`, `pinResultLimit`,
`largeOrgFilteredPinTotal`. Every value is made up: places, people, ids (random UUIDs), image
host (pins.example.org) and file names. Run from anywhere: python3 make_fixtures.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ORG = 'cdcfe0c034ba4cd3cbd03ec5'
USER = 'c379e69a-7aae-449f-a9e3-ed7b91c37a5e'
OWNER = {'orgID': ORG, 'user_id': USER, 'owner': 'Alex Example', 'ownerPhoto': None}

T_TRY = 'a1537f32-74c1-4c19-9b83-c252f8ec2cdc'
T_CAFE = '7e55eb55-0bcd-4d22-8b16-be8052e809da'
T_OPENAIR = '22c20fdd-7e6b-451e-9865-c2fd6ae215f8'
T_BAKERY = '3e92aa23-8804-4ad2-a670-e46fe56c6053'
T_COCKTAILS = '5d627b23-9143-4a0a-a21b-65551f810fc0'
T_READ = '3d3d715b-5b2f-492e-adcc-4cec4b4a240b'
T_PERSO = '5c6f0876-e0e2-4958-9304-6e9ad421ecfe'
T_SNACK = '680affb3-76df-4abe-8e35-93e9f9d4c772'
# Referred to by pins, absent from the file (an edited export).
T_GONE1 = '71fd4203-0e39-434c-9965-3d074347a1f9'
T_GONE2 = '65e166b6-d99d-4c49-9f47-959897e1a63b'

IMG1 = '1c9e1534-2d71-4d94-955a-c5aad5da750e.jpg'
IMG2 = '97d9cd32-abd7-4744-b8ac-fe194ed9be2e.jpg'


def url(file, mode):
    return f'https://pins.example.org/v1/image?file={file}&mode={mode}&oid={ORG}'


def tag(id, name, color, icon):
    return {'type': 'tag', 'id': id, 'name': name, 'color': color, 'icon': icon, **OWNER}


def pin(id, name, lat, lng, tags, dropped, **extra):
    p = {
        'type': 'pin', 'id': id, 'name': name, 'lat': lat, 'lng': lng, 'tags': tags, 'tag_ids': list(tags),
        'date_dropped': dropped, 'date_updated': dropped, 'favourite': False, 'isSecret': False,
        'canEdit': True, 'isOwner': True, 'isOrg': False, **OWNER,
    }
    p.update(extra)
    return p


data = [
    tag(T_TRY, 'À essayer', '#FFB300', 'thought-bubble'),
    tag(T_CAFE, 'Salon de thé / café', '#8d6e63', 'coffee'),
    tag(T_OPENAIR, 'Openair', '#4CAF50', 'sunglasses'),
    tag(T_BAKERY, 'Boulangerie Pâtisserie', '#ff9800', 'croissant'),
    tag(T_COCKTAILS, 'Cocktails', '#7E57C2', 'martini-glass'),
    tag(T_READ, 'Lire commentaire', '#9e9e9e', 'hand'),
    tag(T_PERSO, 'Perso', '#607D8B', None),
    tag(T_SNACK, 'Snack', '#F44336', 'hotdog'),
    pin('c622b7f1-6c02-466a-bdb6-0c8a685fab5c', 'Café Pendule', 48.8590377, 2.3619902, [T_CAFE, T_OPENAIR],
        '2024-11-05T09:12:31.582000+00:00', favourite=True,
        description='Quiet in the morning\nGood filter coffee',
        heroImage=IMG1, heroImageThumb=url(IMG1, 'thumb'), heroImageFull=url(IMG1, 'full'),
        media=[{'id': '4c6c85a7-24b1-4201-a4ad-cf1c9d5d4ba1', 'type': 'media', 'pin_id': 'c622b7f1-6c02-466a-bdb6-0c8a685fab5c',
                'file': IMG1, 'thumb': url(IMG1, 'thumb'), 'full': url(IMG1, 'full'), 'original_name': 'IMG_0001.jpg',
                'mime_type': 'image/jpeg', 'size': 123456, 'created': '2024-11-05T09:13:10+00:00',
                'date_created': '2024-11-05T09:13:10+00:00', 'uploaded_by_name': 'Alex Example', **OWNER}]),
    pin('cc8e3bf2-39c5-4449-816b-48eaf102de3c', 'Boulangerie des Remparts Fictifs', 48.8612, 2.3655, [T_TRY, T_BAKERY, T_GONE1],
        '2024-06-03T08:15:02+00:00', isSecret=True, wishList=False,
        address='5 Rue des Remparts Fictifs, 75003 Paris, France', addressSource='search', website='', phoneNumber='', email='',
        location={'type': 'Point', 'coordinates': [2.3655, 48.8612]}, source='app', timestamp='2024-06-03T08:15:02+00:00',
        heroImage='', media=[]),
    pin('0f6f1c0e-5b6a-4f61-9c55-3f2a8f7d2b10', 'Le Bar Imaginaire', 48.8581, 2.3598, [T_COCKTAILS, T_READ, T_GONE2],
        '2023-09-17T21:04:11.000120+02:00', date_created='2023-09-17T21:04:11.000120+02:00', wishList=True, description='',
        website='https://bar.example.org/', heroImage=IMG2, heroImageThumb=url(IMG2, 'thumb'), heroImageFull=url(IMG2, 'full')),
    pin('8b0e7d4a-2c1f-4e3b-9a6d-5f4c3b2a1e0d', 'Kiosque Sans Nom', 48.8601, 2.3570, [T_PERSO, T_GONE1],
        '2025-02-01T10:00:00+00:00', favourite=True, isSecret=True, description='  Newspapers and postcards\n\n', heroImage=None, media=[]),
    {'type': 'message', 'id': '2e4d6f80-1a3c-4b5d-8e7f-9a0b1c2d3e4f', 'name': 'Welcome', 'messageType': 'info', 'data': {'text': 'Hello'},
     'openedAt': '2024-01-01T00:00:00+00:00', 'photo': None, 'timestamp': '2024-01-01T00:00:00+00:00', **OWNER},
]

doc = {
    'data': data,
    'users': [{'id': USER, 'name': 'Alex Example', 'email': 'alex@example.org'}],
    'org': {'id': ORG, 'name': 'Example', 'isPersonal': True},
    'largeNumberOfPins': False,
    'pinResultLimit': None,
    'largeOrgFilteredPinTotal': None,
}
text = json.dumps(doc, ensure_ascii=False, indent=2) + '\n'
with open(os.path.join(HERE, 'pindrop.json'), 'w', encoding='utf-8') as f:
    f.write(text)
# Cut short in the middle of the pins.
with open(os.path.join(HERE, 'invalid.json'), 'w', encoding='utf-8') as f:
    f.write(text[: text.index('Le Bar Imaginaire')])
