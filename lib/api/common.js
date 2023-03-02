import Base from './base.js';

export default class Common extends Base {
  /**
   * returns gasPrice
   *
   * @returns {Promise}
   */
  gasPrice() {
    return this.requestNode({
      url: 'api/v1/gasPrice',
      method: 'get',
    }).then((data) => data.price);
  }
  /**
   * request gasFees
   *
   * @returns {axios.Promise}
   */
  gasFees() {
    return this.requestNode({
      url: 'api/v1/gasFees',
      method: 'get',
    });
  }
  /**
   * returns polygonscanApiKey
   *
   * @returns {Promise}
   */
  getPolygonscanApiKey() {
    return this.requestNode({
      url: 'api/v1/polygonscanApiKey',
      method: 'get',
    }).then((data) => data.apiKey);
  }
}
