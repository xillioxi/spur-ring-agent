"""Connect the local app using an explicitly authorized Meta developer user token.

Meta's Explorer obtains consent; this module verifies app, expiry, permissions and
linked Professional accounts before saving anything. No callback server is needed.
"""
import logging
import math
import re
import time
from urllib.parse import urlsplit, urlunsplit

from spur.social import SocialError, SocialStore, request_json


class SecretQueryFilter(logging.Filter):
    """httpx logs request URLs at INFO. Never log a token-debug query."""
    def filter(self, record):
        if isinstance(record.args, tuple):
            safe=[]
            for value in record.args:
                text=str(value)
                if 'input_token=' in text or 'fb_exchange_token=' in text:
                    p=urlsplit(text)
                    value=urlunsplit((p.scheme,p.netloc,p.path,'[redacted]',''))
                safe.append(value)
            record.args=tuple(safe)
        return True


logging.getLogger('httpx').addFilter(SecretQueryFilter())


async def connect_developer_token(store, token, client):
    if getattr(store,'mock_profile',None):
        raise SocialError('Connect Instagram in your personal workspace first.')
    if not isinstance(token,str) or not 20<=len(token)<=4096 or any(c.isspace() for c in token):
        raise SocialError('Enter the Meta user access token generated for Spur Ring.')
    repo=SocialStore(store);app=repo.app('instagram')
    if not app:raise SocialError('Configure your Spur Ring Meta application first.')
    base='https://graph.facebook.com/'+app['api_version']+'/'
    result=await request_json(client,'GET',base+'debug_token',
        headers={'Authorization':'Bearer '+app['client_id']+'|'+app['client_secret']},
        params={'input_token':token})
    info=result.get('data',{})
    if info.get('is_valid') is not True or str(info.get('app_id',''))!=app['client_id'] or info.get('type')!='USER':
        raise SocialError('Use a valid User Access Token generated for this Spur Ring app, not another app or a Page token.')
    try:
        expiry=float(info['expires_at'])
        access_expiry=float(info.get('data_access_expires_at',0))
        if access_expiry:expiry=min(expiry,access_expiry)
        if not math.isfinite(expiry) or expiry<=time.time()+90:raise ValueError()
    except (KeyError,ValueError,TypeError):
        raise SocialError('This token has expired or has no verifiable expiry. Generate a fresh user token.') from None
    headers={'Authorization':'Bearer '+token}
    permissions=await request_json(client,'GET',base+'me/permissions',headers=headers)
    scopes=sorted({p['permission'] for p in permissions.get('data',[])
        if p.get('status')=='granted' and isinstance(p.get('permission'),str)})
    missing={'instagram_basic','pages_show_list','pages_read_engagement'}-set(scopes)
    if missing:raise SocialError('Grant these required permissions in Meta: '+', '.join(sorted(missing))+'.')
    accounts=[];page_tokens={};after=None
    for _ in range(10):
        params={'fields':'id,name,access_token,instagram_business_account{id,username}','limit':100}
        if after:params['after']=after
        page=await request_json(client,'GET',base+'me/accounts',headers=headers,params=params)
        for item in page.get('data',[]):
            ig=item.get('instagram_business_account') or {}
            if ig.get('id') and not any(a['id']==str(ig['id']) for a in accounts):
                accounts.append({'id':str(ig['id']),'name':ig.get('username') or item.get('name') or 'Instagram account'})
                if isinstance(item.get('access_token'),str) and item['access_token']:
                    page_tokens[str(ig['id'])]=item['access_token']
        paging=page.get('paging',{});cursor=paging.get('cursors',{}).get('after')
        if not paging.get('next'):break
        if not cursor or cursor==after:raise SocialError('Meta returned incomplete account pagination. Try connecting again.')
        after=cursor
    else:raise SocialError('Too many account pages. Connect using a token limited to the Page you need.')
    # Business portfolio grants can return an empty /me/accounts even when
    # Meta has granted access to specific Pages. Verify those Pages directly.
    if not accounts:
        grants = info.get('granular_scopes') or []
        def targets(scope):
            return {item for grant in grants if grant.get('scope') == scope
                    for item in grant.get('target_ids', [])
                    if isinstance(item, str) and re.fullmatch(r'[0-9]{1,32}', item)}
        allowed_instagram = targets('instagram_basic')
        pages = targets('pages_show_list')
        if len(pages) > 100:
            raise SocialError('Select fewer Pages when authorizing Spur Ring.')
        for page_id in sorted(pages):
            page = await request_json(client, 'GET', base + page_id, headers=headers,
                                      params={'fields': 'id,access_token,instagram_business_account{id,username}'})
            ig = page.get('instagram_business_account') or {}
            ig_id = str(ig.get('id', ''))
            if str(page.get('id')) != page_id or ig_id not in allowed_instagram:
                continue
            if not any(account['id'] == ig_id for account in accounts):
                accounts.append({'id': ig_id, 'name': ig.get('username') or ig_id})
            if page.get('access_token'):
                page_tokens[ig_id] = page['access_token']
    if not accounts:
        raise SocialError('Meta returned no linked Instagram Professional account. Link your Business or Creator Instagram to a Facebook Page you manage, then grant that Page during authorization.')
    # Keep the actual verified expiry; short-lived Explorer tokens are not permanent.
    repo.connect('instagram',{'access_token':token,'expires_in':expiry-time.time(),
        'granted_scopes':scopes,'page_tokens':page_tokens,'auth_method':'developer_token'},accounts)
    return repo.public('instagram')
