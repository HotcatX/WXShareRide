import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTestDatabase } from './helpers/database.ts';
import { getRideParticipants } from '../src/rides/participants.ts';
import { listBlocks } from '../src/blocks/service.ts';
import { getMarketListing } from '../src/market/read.ts';
import { updateUser } from '../src/users/service.ts';

test('ride, block and ordinary seller projections all follow the current single avatar reference', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const { pool } = db, appId = 'avatar-projection-fixture';
  const users = (await pool.query(`INSERT INTO users(app_id,openid,name) VALUES
    ($1,'synthetic-avatar-owner','Owner'),($1,'synthetic-avatar-viewer','Viewer') RETURNING id`, [appId])).rows;
  const owner = users[0].id, viewer = users[1].id, ride = randomUUID(), listing = randomUUID();
  await pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
    VALUES($1,'offer',$2,'ny_nj','open',4,now()+interval '1 day','America/New_York')`, [ride, owner]);
  await pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state) VALUES
    ($1,$2,'driver',0,'active'),($1,$3,'passenger',1,'active')`, [ride, owner, viewer]);
  await pool.query('INSERT INTO user_blocks(blocker_id,target_id) VALUES($1,$2)', [viewer, owner]);
  await pool.query(`INSERT INTO market_listings(app_id,id,owner_user_id,status,expires_at,content)
    VALUES($1,$2,$3,'online',now()+interval '1 day',$4)`, [appId, listing, owner,
    { listingType: 'goods', title: 'Synthetic desk', description: '', priceCents: 100,
      category: '', condition: '', region: { state: 'NJ', county: '', area: '' },
      buildingName: '', location: null, startDate: '', endDate: '', sellerContact: null, sublet: null }]);
  const files: string[] = [];
  for (let i = 0; i < 2; i++) {
    const id = randomUUID(); files.push(id);
    await pool.query(`INSERT INTO files(id,app_id,provider,locator,owner_user_id,status,size_bytes,media_type,sha256,verified_at,upload_request_key)
      VALUES($1,$2,'cos',$3,$4,'ready',94,'image/png',$5,now(),$6)`,
    [id, appId, `synthetic/avatar/${id}`, owner, 'a'.repeat(64), `avatar-fixture-${i}`]);
  }
  for (const avatarFileId of [null, files[0], files[1], null]) {
    await updateUser(pool, owner, randomUUID(), { avatarFileId });
    const participants = await getRideParticipants(pool, viewer, ride);
    const seller = await getMarketListing(pool, appId, listing, viewer);
    assert.ok('seller' in seller);
    const projections = [participants.participants.find(member => member.id === owner),
      (await listBlocks(pool, viewer, {})).blocks[0], seller.seller];
    for (const value of projections) {
      assert.ok(value);
      assert.equal(value.avatarFileId, avatarFileId);
      assert.equal('avatarUrl' in value, false);
      assert.equal(JSON.stringify(value).includes('synthetic/avatar/'), false);
    }
    assert.equal(participants.participants.find(member => member.id === viewer)?.avatarFileId, null);
  }
  // Replacing a reference never deletes either physical-file ledger entry.
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM files WHERE status='ready'")).rows[0].n, 2);
});
