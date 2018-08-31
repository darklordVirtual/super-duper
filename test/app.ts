import * as Promise from 'bluebird';
import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import * as http from 'http';
import * as _ from 'lodash';
import * as nock from 'nock';
import * as vpnClient from 'openvpn-client';
import * as path from 'path';
import * as querystring from 'querystring';

const { expect } = chai;

import tunnelWorker from '../src/connect-proxy/worker';
import { service } from '../src/service';
import { request } from '../src/utils';
import vpnWorker from '../src/worker';

const vpnHost = process.env.VPN_HOST || '127.0.0.1';
const vpnPort = process.env.VPN_PORT || '443';
const caCertPath = process.env.CA_CERT_PATH || path.resolve(__dirname, 'data/ca.crt');
const RESIN_API_HOST = process.env.RESIN_API_HOST!;
const VPN_SERVICE_API_KEY = process.env.VPN_SERVICE_API_KEY!;
const VPN_CONNECT_PROXY_PORT = process.env.VPN_CONNECT_PROXY_PORT!;

const vpnDefaultOpts = [
	'--client',
	'--remote', vpnHost, vpnPort,
	'--ca', caCertPath,
	'--dev', 'tun',
	'--proto', 'tcp-client',
	'--comp-lzo',
	'--verb', '3',
];

interface HttpServerAsync {
	listenAsync(port: number): Promise<HttpServerAsync>;
	closeAsync(): Promise<HttpServerAsync>;
}

before(() => {
	chai.use(chaiAsPromised);
});

describe('vpn worker', function() {
	this.timeout(10 * 1000);

	before(() => {
		nock(`https://${RESIN_API_HOST}`)
		.post('/v4/service_instance')
		.query({ apikey: VPN_SERVICE_API_KEY })
		.reply(200, { id: _.random(1, 1024) });
	});

	it('should resolve true when ready', () =>
		expect(service.register().then(() => vpnWorker(1))).to.eventually.be.true);
});

describe('tunnel worker', () =>
	it('should startup successfully', () => {
		tunnelWorker(VPN_CONNECT_PROXY_PORT);
	})
);

describe('VPN Events', function() {
	this.timeout(30 * 1000);

	const getEvent = (name: string) =>
		new Promise<string>((resolve) => {
			nock(`https://${process.env.RESIN_API_HOST}`)
			.post(`/services/vpn/client-${name}`, /common_name=user2/g)
			.query({apikey: VPN_SERVICE_API_KEY})
			.reply(200,(_uri: string, body: any) => {
				resolve(body);
				return 'OK';
			});
		});

	before(() => {
		nock(`https://${RESIN_API_HOST}`)
		.get('/services/vpn/auth/user2')
		.query({ apikey: 'pass' })
		.reply(200, 'OK');
	});

	it('should send a client-connect event', function() {
		const connectEvent = getEvent('connect')
		.then((body) => {
			const data = querystring.parse(body);
			expect(data).to.have.property('common_name').that.equals('user2');
			expect(data).to.not.have.property('real_address');
			expect(data).to.have.property('virtual_address').that.match(/^10\.2[45][0-9]\.[0-9]+\.[0-9]+$/);
		});

		this.client = vpnClient.create(vpnDefaultOpts);
		this.client.authenticate('user2', 'pass');
		return this.client.connect().return(connectEvent);
	});

	it('should send a client-disconnect event', function() {
		const disconnectEvent = getEvent('disconnect')
		.then((body) => {
			const data = querystring.parse(body);
			expect(data).to.have.property('common_name').that.equals('user2');
			expect(data).to.not.have.property('real_address');
			expect(data).to.not.have.property('virtual_address');
		});

		return this.client.disconnect().return(disconnectEvent);
	});
});

describe('VPN proxy', function() {
	this.timeout(30 * 1000);

	const vpnTest = (credentials: {user: string, pass: string}, func: () => any): Promise<HttpServerAsync> => {
		const server = Promise.promisifyAll(http.createServer(
			(_req, res) => {
				res.writeHead(200, {'Content-type': 'text/plain'});
				res.end('hello from 8080');
			})) as any as HttpServerAsync;

		return Promise.using(vpnClient.connect(credentials, vpnDefaultOpts), () =>
			server.listenAsync(8080)
			.tap(() => func())
			.tap(() => server.closeAsync()));
	};

	beforeEach(() => {
		nock(`https://${RESIN_API_HOST}`)

		.get(/\/services\/vpn\/auth\/user[345]/)
		.query({apikey: 'pass'})
		.reply(200, 'OK')

		.post(/\/services\/vpn\/client-(?:dis)?connect/, /common_name=user[345]/g)
		.query({apikey: VPN_SERVICE_API_KEY})
		.times(2)
		.reply(200, 'OK');
	});

	describe('web accessible device', () => {
		beforeEach(() => {
			nock(`https://${RESIN_API_HOST}`)
			.get('/v4/device')
			.query({
				$select: 'id,uuid,is_web_accessible,is_connected_to_vpn',
				$filter: "uuid eq 'deadbeef'",
				apikey: VPN_SERVICE_API_KEY,
			})
			.reply(200, { d: [ { uuid: 'deadbeef', is_web_accessible: 1, is_connected_to_vpn: 1 } ] });
		});

		it('should allow port 8080 without authentication', () =>
			vpnTest({ user: 'user3', pass: 'pass' }, () =>
				request({ url: 'http://deadbeef.resin:8080/test', proxy: 'http://localhost:3128', tunnel: true })
				.then((response) => {
					expect(response).to.have.property('statusCode').that.equals(200);
					expect(response).to.have.property('body').that.equals('hello from 8080');
				})));
	});

	describe('not web accessible device', () => {
		beforeEach(() => {
			nock(`https://${RESIN_API_HOST}`)
			.get('/v4/device')
			.query({
				$select: 'id,uuid,is_web_accessible,is_connected_to_vpn',
				$filter: "uuid eq 'deadbeef'",
				apikey: VPN_SERVICE_API_KEY,
			})
			.reply(200, { d: [ { uuid: 'deadbeef', is_web_accessible: 0, is_connected_to_vpn: 1 } ] });
		});

		it('should not allow port 8080 without authentication', () =>
			vpnTest({ user: 'user4', pass: 'pass' }, () =>
				expect(request({ url: 'http://deadbeef.resin:8080/test', proxy: 'http://localhost:3128', tunnel: true })).to.eventually.be.rejected));

		it('should allow port 8080 with authentication', () =>
			vpnTest({user: 'user5', pass: 'pass'}, () =>
				request({
					url: 'http://deadbeef.resin:8080/test',
					proxy: 'http://resin_api:test_api_key@localhost:3128',
					tunnel: true,
				})
				.then((response) => {
					expect(response).to.have.property('statusCode').that.equals(200);
					expect(response).to.have.property('body').that.equals('hello from 8080');
				})));
	});
});