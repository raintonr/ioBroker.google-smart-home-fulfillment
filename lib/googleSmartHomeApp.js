class GoogleSmartHomeApp {
    constructor(adapter, instanceSettings) {
        adapter.log.debug('GoogleSmartHomeApp: constructor');
        this.adapter = adapter;
        this.instanceSettings = instanceSettings;
        this.plugins = [];

        const actionsOnGoogle = require('actions-on-google');
        this.app = actionsOnGoogle.smarthome({
            debug: true,
            jwt: instanceSettings.homeGraphJSONKey
        });
    }

    getApp() {
        return this.app;
    }

    async getPlugins() {
        this.adapter.log.debug('getPlugins...');
        // The below really should be plugable modules so that each ioBroker adapter
        // can add it's own logic (as only each adapter can know it's devices and how
        // they should map to Google Home).

        // Anyhow, start with Loxone...
        const Loxone = require('./plugins/loxone/loxone.js');
        const loxone = new Loxone(this.adapter, this.instanceSettings, this.app);
        if (loxone.enabled()) {
            loxone.init();
            this.plugins.push(loxone);
        }

        // TODO: think about exiting somehow if there are no enabled plugins
        if (this.plugins.length == 0) {
            this.adapter.log.warn('No plugins enabled - that is pretty pointless!');
        }
    }

    async getDevices() {
        this.adapter.log.debug('GoogleSmartHomeApp getDevices...');
        // gDevices is the array of devices to return in the payload of a Google SYNC request.
        const gDevices = [];

        // We will build an object of handler objects for each device so we know who to call
        // on EXECUTE, QUERY, etc. requests from Google.
        this.deviceHandlers = Object();

        for(const plugin of this.plugins) {
            const pDevices = await plugin.getDevices();
            // Collate the devices from this plugin
            Object.values(pDevices).forEach(device => {
                gDevices.push(device.gDevice);
                this.deviceHandlers[device.gDevice.id] = device.handlers;
            });
        }
        this.adapter.log.debug('getDevices returning: ' + JSON.stringify(gDevices));
        return gDevices;
    }

    async requestSync() {
        this.adapter.log.debug('Requesting sync');
        this.app.requestSync(this.instanceSettings.agentUserId)
            .then(() => {
                this.adapter.log.debug('requestSync done');
            })
            .catch(() => {
                this.adapter.log.error('requestSync failed');
            });
    }

    async onSync(body) {
        this.adapter.log.debug('onSync...');
        const devices = await this.getDevices();
        return {
            requestId: body.requestId,
            payload: {
                agentUserId: this.instanceSettings.agentUserId,
                devices: devices
            }
        };
    }

    executeErrorPayload(id) {
        return {
            ids: [id],
            status: 'ERROR',
            errorCode: 'deviceNotReady'
        };
    }

    async onExecute(body) {
        this.adapter.log.debug('onExecute...');
        const { requestId } = body;
        const results = [];
        const intent = body.inputs[0];
        for (const command of intent.payload.commands) {
            for (const device of command.devices) {
                for (const execution of command.execution) {
                    if (this.deviceHandlers && device.id in this.deviceHandlers) {
                        this.adapter.log.debug(`Execute ${execution.command} for device ${device.id}`);
                        results.push(await this.deviceHandlers[device.id].onExecute(device.id, command.execution));
                    } else {
                        this.adapter.log.error(`Cannot ${execution.command} for device ${device.id} - no handler!`);
                        results.push(this.executeErrorPayload(device.id));
                    }
                }
            }
        }
        return {
            requestId: requestId,
            payload: {
                commands: results,
            },
        };
    }

    queryErrorPayload(id) {
        return {
            [id]: {
                status: 'ERROR',
                errorCode: 'deviceNotReady'
            }
        };
    }

    async onQuery(body) {
        this.adapter.log.debug('onQuery...');
        const { requestId } = body;
        const devices = Object();
        for (const device of body.inputs[0].payload.devices) {
            if (this.deviceHandlers && device.id in this.deviceHandlers) {
                this.adapter.log.debug(`Query device ${device.id}`);
                Object.assign(devices, await this.deviceHandlers[device.id].onQuery(device.id));
            } else {
                this.adapter.log.debug(`Query device ${device.id}`);
                Object.assign(devices, this.queryErrorPayload(device.id));
            }
        }
        return {
            requestId: requestId,
            payload: {
                devices: devices,
            },
        };
    }

    async init() {
        this.app.onSync(this.onSync.bind(this));
        this.app.onExecute(this.onExecute.bind(this));
        this.app.onQuery(this.onQuery.bind(this));

        // Build our list of plugins
        await this.getPlugins();

        // Load devices in case a sync fails but other requests don't.
        // Slightly inefficient.
        // TODO: Consider keeping a flag that could invalidate our device list?
        await this.getDevices();

        // Create a requestSync event handler so plugins can trigger one...
        this.adapter.on('requestSync', this.requestSync.bind(this));
        // ... and as we're starting trigger a sync ourselves.
        this.adapter.emit('requestSync');
        // ... and do this periodically if defined
        if (this.instanceSettings.syncInterval) {
            setInterval(() => {
                this.adapter.emit('requestSync');
            }, 60000 * this.instanceSettings.syncInterval); // syncInterval is in minutes
        }
    }
}

module.exports = GoogleSmartHomeApp;