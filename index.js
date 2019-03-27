const lgtv2 = require('lgtv2');
const wol = require('wake_on_lan');
const tcpp = require('tcp-ping');
const cec = require('cec-promise');

let Service, Characteristic;

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    homebridge.registerAccessory('homebridge-webos3', 'webos3', webos3Accessory);
};

// MAIN SETUP
function webos3Accessory(log, config, api) {
    this.log = log;
    this.ip = config['ip'];
    this.name = config['name'];
    this.mac = config['mac'];
    this.keyFile = config['keyFile'];
    this.volumeControl = config['volumeControl'];
    if (this.volumeControl == undefined) {
        this.volumeControl = true;
    }
    this.channelControl = config['channelControl'];
    if (this.channelControl == undefined) {
        this.channelControl = true;
    }
    this.channelIdMap = {};
    this.channelConstant = 0;
    this.pollingEnabled = config['pollingEnabled'];
    if (this.pollingEnabled == undefined) {
        this.pollingEnabled = false;
    }
    this.alivePollingInterval = config['pollingInterval'] || 5;
    this.alivePollingInterval = this.alivePollingInterval * 1000;
    this.appSwitch = config['appSwitch'];

    this.url = 'ws://' + this.ip + ':3000';
    this.enabledServices = [];
    this.connected = false;
    this.checkCount = 0;
    this.checkAliveInterval = null;

    this.cecControlNibble = config['cecAddress'];
    this.cecAddressByte = ((14 % 16) << 4) | (this.cecControlNibble % 16);

    lgtv = new lgtv2({
        url: this.url,
        timeout: 5000,
        reconnect: 3000,
        keyFile: this.keyFile
    });

    lgtv.on('connect', () => {
        this.log.info('webOS - connected to TV');
        this.connected = true;
        if (!this.checkAliveInterval && this.pollingEnabled) {
            this.checkAliveInterval = setInterval(this.checkTVState.bind(this, this.pollCallback.bind(this)), this.alivePollingInterval);
        }
        lgtv.subscribe('ssap://com.webos.applicationManager/getForegroundAppInfo', (err, res) => {
            if (res && res.appId) {
                this.log.info('webOS - current appId: %s', res.appId);

                this.setAppSwitchManually(null, true, res.appId)
            }
        });

        lgtv.subscribe('ssap://audio/getVolume', (err, res) => {
            if (res.volume) {
                this.log.info('webOS - volume changed', res.volume);
                this.setVolumeLevelManually(null, parseInt(res.volume))
            } 

            if (res.muted != undefined) {
                this.log.info('webOS - mute changed', res.muted);
                this.setMuteStateManually(null, !res.muted)
            }
        });

        lgtv.subscribe('ssap://tv/getCurrentChannel', (err, res) => {
            if (res.channelNumber) {
                this.log.info('webOS - channel number changed', res.channelNumber);
                this.setChannelManually(null, parseInt(res.channelNumber))
            }
        });

        lgtv.request('ssap://tv/getChannelList', (err, res) => {
            this.channelIdMap = res.channelList.reduce((dict, x) => {
                dict[x.channelNumber] = x.channelId
                return dict
            }, {})
		});

        this.updateAccessoryStatus();
    });

    lgtv.on('close', () => {
        this.log.info('webOS - disconnected from TV');
        this.connected = false;
        //if(this.checkAliveInterval) {
        //  clearInterval(this.checkAliveInterval);
        //  this.checkAliveInterval = undefined;
        //}
    });

    lgtv.on('error', (error) => {
        this.log.error('webOS - %s', error);
        //this.connected = false;
        //setTimeout(lgtv.connect(this.url), 5000);
    });

    lgtv.on('prompt', () => {
        this.log.info('webOS - prompt for confirmation');
        this.connected = false;
    });

    lgtv.on('connecting', () => {
        this.log.debug('webOS - connecting to TV');
        this.connected = false;
    });

    cec.on('REPORT_POWER_STATUS', status => {
        this.log(`${this.name} reportStatus: ${status}`);
        if (Number(status.source) === this.cecControlNibble) {
          const powerStatus = (() => {
            switch (status.args[0]) {
              case cec.code.PowerStatus.ON: return 'on';
              case cec.code.PowerStatus.STANDBY: return 'standby';
              default: return 'unknown';
            }
          })();
          this.log(`${this.name} reportStatus: ${powerStatus}`);
          //callback(powerStatus);
        }
      });


    this.powerService = new Service.Switch(this.name + " Power", "powerService");
    this.informationService = new Service.AccessoryInformation();

	
    this.powerService
        .getCharacteristic(Characteristic.On)
        .on('get', this.getState.bind(this))
        .on('set', this.setState.bind(this));

    this.informationService
        .setCharacteristic(Characteristic.Manufacturer, 'LG Electronics Inc.')
        .setCharacteristic(Characteristic.Model, 'webOS TV')
        .setCharacteristic(Characteristic.SerialNumber, '-')
        .setCharacteristic(Characteristic.FirmwareRevision, '0.9.3');

		
    this.enabledServices.push(this.powerService);
    this.enabledServices.push(this.informationService);
	
    this.prepareVolumeService();
    this.prepareChannelConstantService();
	this.prepareAppSwitchService();

}

// SETUP COMPLEX SERVICES

webos3Accessory.prototype.prepareVolumeService = function () {
	
	if(!this.volumeControl){
		return;
	}
	
    this.volumeService = new Service.Lightbulb(this.name + " Volume", "volumeService");
	
    this.volumeService
        .getCharacteristic(Characteristic.On)
        .on('get', this.getMuteState.bind(this))
        .on('set', this.setMuteState.bind(this));

    this.volumeService
        .addCharacteristic(new Characteristic.Brightness())
        .on('get', this.getVolume.bind(this))
        .on('set', this.setVolume.bind(this));
		
	this.enabledServices.push(this.volumeService);
	
};

webos3Accessory.prototype.prepareChannelConstantService = function () {
	
	if(!this.channelControl) {
		return;
	}
	
    this.channelConstantService = new Service.Lightbulb(this.name + " Channel Constant", "channelConstantService");
	
    this.channelConstantService
        .getCharacteristic(Characteristic.On)
        .on('get', (callback) => {
            callback(null, this.channelConstant > 0)
        })
        .on('set', (state, callback) => {
            this.channelConstant = state ? 1 : 0
            callback(null, this.channelConstant)
        }); 

    this.channelConstantService
        .addCharacteristic(new Characteristic.Brightness())
        .on('get', (callback) => {
            callback(null, this.channelConstant);
        })
        .on('set', (constant, callback) => {
            this.channelConstant = constant
            callback(null, this.channelConstant);
        }); 
		
	this.enabledServices.push(this.channelConstantService);
};

webos3Accessory.prototype.prepareAppSwitchService = function () {
	
	if(this.appSwitch == undefined ||  this.appSwitch == null || this.appSwitch.length <= 0){
		return;
	}
	
	let isArray = Array.isArray(this.appSwitch);
	
	if(isArray){
		this.appSwitchService = new Array();
		this.appSwitch.forEach((value, i) => {
            this.appSwitch[i] = str = this.appSwitch[i].replace(/\s/g, '');
            if (this.appSwitch[i] == 'com.webos.app.livetv') {
                this.appSwitchService[i] = new Service.Lightbulb(this.name + " App: " + value, "appSwitchService" + i);
            } else {
                this.appSwitchService[i] = new Service.Switch(this.name + " App: " + value, "appSwitchService" + i);
            }
		});
	}else{
		this.appSwitchService = new Service.Switch(this.name + " App: " + this.appSwitch, "appSwitchService");
	}
	
	if(isArray){
		this.appSwitch.forEach((value, i) => {
			this.appSwitchService[i]
				.getCharacteristic(Characteristic.On)
				.on('get', (callback) => {
						this.getAppSwitchState(callback, this.appSwitch[i]);
					})
				.on('set', (state, callback) => {
						this.setAppSwitchState(state, callback, this.appSwitch[i]);
                    });
            if (this.appSwitch[i] == 'com.webos.app.livetv') {
                this.appSwitchService[i]
                .addCharacteristic(new Characteristic.Brightness())
                .on('get', this.getChannel.bind(this))
                .on('set', this.setChannel.bind(this));
            }
		});
	}else{
		this.appSwitchService
			.getCharacteristic(Characteristic.On)
			.on('get', (callback) => {
						this.getAppSwitchState(callback, this.appSwitch);
					})
			.on('set', (state, callback) => {
						this.setAppSwitchState(state, callback, this.appSwitch);
					});
	}
	
	if(isArray){
		this.appSwitch.forEach((value, i) => {
			this.enabledServices.push(this.appSwitchService[i]);
		});
	}else{
		this.enabledServices.push(this.appSwitchService);
	}
	
};

// HELPER METHODS
webos3Accessory.prototype.setMuteStateManually = function (error, value) {
    if (this.volumeService) this.volumeService.getCharacteristic(Characteristic.On).updateValue(value);
};

webos3Accessory.prototype.setVolumeLevelManually = function (error, value) {
    if (this.volumeService) this.volumeService.getCharacteristic(Characteristic.Brightness).updateValue(value);
};

webos3Accessory.prototype.setChannelManually = function (error, value) {
    if (this.appSwitchService && this.channelConstantService) {
        
        let isArray = Array.isArray(this.appSwitch);
        
        if(isArray){
            this.appSwitch.forEach((app, i) => {
                this.appSwitch[i] = str = this.appSwitch[i].replace(/\s/g, '');
                if (this.appSwitch[i] == 'com.webos.app.livetv') {
                    const channel = value % 100
                    const constant = (value - (value % 100)) / 100

                    //this.log.info('webOS - channel:' + channel +' constant:' + constant);

                    this.appSwitchService[i].getCharacteristic(Characteristic.Brightness).updateValue(channel);
                    this.channelConstantService.getCharacteristic(Characteristic.Brightness).updateValue(constant);
                    this.channelConstantService.getCharacteristic(Characteristic.On).updateValue(constant > 0);
                    this.channelConstant = constant
                }
            });
        }
    }
};

webos3Accessory.prototype.setAppSwitchManually = function (error, value, appId) {
	if(this.appSwitchService){
		if(Array.isArray(this.appSwitch)){
			if(appId == undefined || appId == null || appId.length <= 0){
				this.appSwitch.forEach((value, i) => {
					this.appSwitchService[i].getCharacteristic(Characteristic.On).updateValue(value);
				});
			}else {
				this.appSwitch.forEach((tmpVal, i) => {
					if(appId === tmpVal){
						this.appSwitchService[i].getCharacteristic(Characteristic.On).updateValue(value);
					}else {
						this.appSwitchService[i].getCharacteristic(Characteristic.On).updateValue(false);
					}
				});
			}
		}else{
			this.appSwitchService.getCharacteristic(Characteristic.On).updateValue(value);
		}
	}
};

webos3Accessory.prototype.updateAccessoryStatus = function () {
    // if (this.volumeService) this.checkMuteState(this.setMuteStateManually.bind(this));
	// if (this.appSwitchService) this.checkForegroundApp(this.setAppSwitchManually.bind(this));
};

webos3Accessory.prototype.pollCallback = function (error, status) {
    if (!status) {
        this.powerService.getCharacteristic(Characteristic.On).updateValue(status);
        if (this.channelConstantService) this.channelConstantService.getCharacteristic(Characteristic.On).updateValue(status);
        this.setMuteStateManually(null, false);
        this.setAppSwitchManually(null, false, null);
    } else {
        this.powerService.getCharacteristic(Characteristic.On).updateValue(status);
    }
};

webos3Accessory.prototype.powerOnTvWithCallback = function (callback) {
	wol.wake(this.mac, (error) => {
		if (error) {
			this.log.info('webOS - wake on lan error');
			return;
		}
		let x = 0;
		let appLaunchInterval = setInterval(() => {
			if(this.connected){
				setTimeout(callback.bind(this), 1000);
				clearInterval(appLaunchInterval);  
				return;
			}
			
			lgtv.connect(this.url);	

			if (x++ === 7) {
			   clearInterval(appLaunchInterval);
			   return;
			}
		}, 2000);
	});
};

webos3Accessory.prototype.checkTVState = function (callback) {
    tcpp.probe(this.ip, 3000, (err, isAlive) => {
        this.log.debug('webOS - TV state: %s', isAlive ? "On" : "Off");

        if (!isAlive) {
            this.connected = false;
            callback(null, this.connected);
        } else {
            this.checkCount = 0;
            this.checkWakeOnLan(callback);
        }
    });
};

webos3Accessory.prototype.checkMuteState = function (callback) {
    if (this.connected) {
        lgtv.request('ssap://audio/getStatus', (err, res) => {
            if (!res || err) {
                callback(new Error('webOS - TV mute check - error while getting current mute state'));
            } else {
                this.log.info('webOS - TV muted: %s', res.mute ? "Yes" : "No");
                callback(null, !res.mute);
            }
        });
    } else {
        callback(null, false);
    }
};

webos3Accessory.prototype.checkVolumeLevel = function (callback) {
    if (this.connected) {
        lgtv.request('ssap://audio/getVolume', (err, res) => {
            if (!res || err) {
                callback(new Error('webOS - TV volume - error while getting current volume'));
            } else {
                this.log.info('webOS - TV volume: ' + res.volume);
                callback(null, parseInt(res.volume));
            }
        });
    } else {
        callback(null, false);
    }
};

webos3Accessory.prototype.checkCurrentChannel = function (callback) {
    if (this.connected) {
        lgtv.request('ssap://tv/getCurrentChannel', (err, res) => {
            if (!res || err) {
                callback(new Error('webOS - TV channel - error while getting current channel'));
            } else {
                this.log.info('webOS - TV channel: ' + res.channelNumber);

                const channelNumber = parseInt(res.channelNumber)
                const channel = channelNumber % 100
                const constant = (channelNumber - (channelNumber % 100)) / 100
                this.channelConstant = constant

                //this.log.info('webOS - channel:' + channel +' constant:' + constant);

                callback(null, channel);
            }
        });
    } else {
        callback(null, false);
    }
};

webos3Accessory.prototype.checkForegroundApp = function (callback, appId) {
    if (this.connected) {
        lgtv.request('ssap://com.webos.applicationManager/getForegroundAppInfo', (err, res) => {
            if (!res || err) {
                callback(new Error('webOS - current app - error while getting current app info'));
            } else {
                this.log.debug('webOS - TV current appId: %s', res.appId);
				if (appId == undefined || appId == null) { // if appId undefined or null then i am checking which app is currently running; if set then continue normally
                    callback(null, true, res.appId);
                } else if (res.appId === appId) {
                    callback(null, true, appId);
                } else {
                    callback(null, false, appId);
                }
            }
        });
    } else {
        callback(null, false);
    }
};

webos3Accessory.prototype.checkWakeOnLan = function (callback) {
    if (this.connected) {
        this.checkCount = 0;
        callback(null, true);
    } else {
        if (this.checkCount < 5) {
            this.checkCount++;
            lgtv.connect(this.url);
            setTimeout(this.checkWakeOnLan.bind(this, callback), 12000);
        } else {
            this.checkCount = 0;
            callback(new Error('webOS - wake timeout'));
        }
    }
};

// HOMEBRIDGE STATE SETTERS/GETTERS
webos3Accessory.prototype.getState = function (callback) {
    //lgtv.connect(this.url);
    this.checkTVState.call(this, callback);
};

webos3Accessory.prototype.setState = function (state, callback) {
    if (state) {
        if (!this.connected) {
            // wol.wake(this.mac, (error) => {
            //     if (error) return callback(new Error('webOS - wake on lan error'));
            //     this.checkCount = 0;
            //     setTimeout(this.checkWakeOnLan.bind(this, callback), 5000);
            // })
            cec.request(this.cecAddressByte, 'GIVE_DEVICE_POWER_STATUS', 'REPORT_POWER_STATUS')
                .then((res) => {
                    var on = res.status ? 0 : 1;
                    this.log(`${this.name} getOn: ${on}`);
                    
                    if (state == on) {
                        this.log(`${this.name} setOn: already ${state ? 'on' : 'off'}`);
                      } else {
                        let newMode = state ? 'on' : 'standby';
                        this.log(`${this.name} setOn: ${state}`);
                        cec.send(`${newMode} ${this.cecControlNibble}`);
                      }
                      this.checkCount = 0;
                      setTimeout(this.checkWakeOnLan.bind(this), 5000);
                      callback(null, true);

                })
                .catch((err) => {
                    this.log(err);
                    callback(err);
                });




        } else {
            callback(null, true);
        }
    } else {
        if (this.connected) {
            lgtv.request('ssap://system/turnOff', (err, res) => {
                if (err) return callback(null, false);
                lgtv.disconnect();
                this.connected = false;
				this.setMuteStateManually(null, false);
				this.setAppSwitchManually(null, false, null);
                callback(null, true);
            })
        } else {
            callback(new Error('webOS - is not connected'))
        }
    }
};


webos3Accessory.prototype.getMuteState = function (callback) {
    setTimeout(this.checkMuteState.bind(this, callback), 50);
};

webos3Accessory.prototype.setMuteState = function (state, callback) {
    if (this.connected) {
        lgtv.request('ssap://audio/setMute', {mute: !state});
        callback(null, state);
    } else {
        callback(new Error('webOS - is not connected'))
    }
};


webos3Accessory.prototype.getVolume = function (callback) {
    setTimeout(this.checkVolumeLevel.bind(this, callback), 50);
};

webos3Accessory.prototype.setVolume = function (level, callback) {
    if (this.connected) {
        if (level > 30) {
            level = 30
        }
        lgtv.request('ssap://audio/setVolume', {volume: level});
        callback(null, level);
    } else {
        callback(new Error('webOS - is not connected'))
    }
};

webos3Accessory.prototype.getChannel = function (callback) {
    setTimeout(this.checkCurrentChannel.bind(this, callback), 50);
};

webos3Accessory.prototype.setChannel = function (level, callback) {
    if (this.connected) {
        const constant = this.channelConstant < 10 ? (this.channelConstant * 100) :
            ((this.channelConstant - this.channelConstant%10) * 10)
        const channelNumber = constant + level
        const channelId = this.channelIdMap[channelNumber]
        if (channelId != undefined) {
            lgtv.request('ssap://tv/openChannel', {channelId: channelId, channelNumber: channelNumber});
            callback(null, level);
        } else {
            this.checkCurrentChannel(callback);
        }
    } else {
        callback(new Error('webOS - is not connected'))
    }
};

webos3Accessory.prototype.getAppSwitchState = function (callback, appId) {
    if (!this.connected) {
        callback(null, false);
    } else {
        setTimeout(this.checkForegroundApp.bind(this, callback, appId), 50);
    }
};

webos3Accessory.prototype.setAppSwitchState = function (state, callback, appId) {
    if (this.connected) {
        if (state) {
            lgtv.request('ssap://system.launcher/launch', {id: appId});
            this.setAppSwitchManually(null, true, appId);
        } else {
            lgtv.request('ssap://system.launcher/launch', {id: "com.webos.app.livetv"});
            this.setAppSwitchManually(null, true, "com.webos.app.livetv");
        }
        callback(null, state);
    } else {
		
		// if (state) {
		// 	this.log.info('webOS - Trying to launch %s but TV is off, attempting to power on the TV', appId);
		// 	this.powerOnTvWithCallback(() => {
		// 		lgtv.request('ssap://system.launcher/launch', {id: appId});
		// 		callback(null, true);
		// 	});
        // }
		
      //  callback(new Error('webOS - is not connected'))
    }
};

webos3Accessory.prototype.getServices = function () {
    return this.enabledServices;
};

