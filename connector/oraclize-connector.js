/*
Copyright (c) 2015-2016 Oraclize SRL
Copyright (c) 2016 Oraclize LTD
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/

'use strict';
const shim = require('fabric-shim')
const crypto = require('crypto')
const request = require('request')
const CBOR = require('cbor-sync');

let nonce = 0

async function createId2(stub) { // compute the ID2
  try {
    const binding = stub.getBinding() // Get bindings
    nonce++ // Increment the nonce
    const hash = crypto.createHash('sha256') // Set sha256
    hash.update(binding + nonce)
    return hash.digest('hex') // return the value in hexadecimal
  } catch (error) {
    console.log('\x1b[31m%s\x1b[0m', 'Error in createId2: ', error)
    return shim.error(error)
  }
}

async function createContext(stub) {
  const binding = stub.getBinding()
  const timestamp = Math.floor(Date.now() / 1000) // Need the time in seconds
  const context = {
    protocol: "fabric",
    type: "dlt",
    relative_timestamp: timestamp
  }
  return context
}

let Chaincode = class { // Implements the Oraclize chaincode
  async Init(stub) {
    console.info('=========== Instantiated fabcar chaincode ===========')
    return shim.success()
  }

  async Invoke(stub) {
    let ret = stub.getFunctionAndParameters() // Get function and argument passed to the invoke
    console.info("Invoked function: ", ret)
    let method = this[ret.fcn]
    if (!method) throw new Error('\x1b[31m%s\x1b[0m', 'Received unknown function ' + ret.fcn + ' invocation')
    try {
      let payload = await method(stub, ret.params)
      return shim.success(payload)
    } catch (err) {
      console.error('\x1b[31m%s\x1b[0m', "Error in Invoke method: ", err)
      return shim.error(err)
    }
  }

  async oraclizeQuery(stub, args) { // HTTPS POST request to the Oraclize API
    if (args.length != 3) throw new Error('\x1b[31m%s\x1b[0m', 'Error: incorrect number of arguments. Expecting 3');
    const id2 = await createId2(stub); // Create the ID2
    const context = await createContext(stub); // Create the context
    console.log("context: ", context);
    const datasource = args[0] // Receive datasource
    const query = args[1] // Receive query
    const proofType = parseInt(args[2]) // Receive proofType
    console.log('\x1b[35m%s\x1b[0m', '============= START : oraclizeQuery ===========');
    console.log('dataset:', datasource, "\nquery: ", query, "\nproofType: ", proofType, "\nid2: ", id2)
    const promise = () => // The oraclizeQuery needs to be a promise in order to return the json to the user chaincode
      new Promise((resolve, reject) => {
        request.post('https://api.oraclize.it/v1/contract/create', {
          json: {
            datasource: datasource,
            query: query,
            proof_type: proofType,
            id2: id2,
            context: context
          }
        }, (err, res, body) =>
            !err || res.statusCode === 200
              ? resolve(body)
              : reject(new Error("Query failed because of an error or for a status code != 200!")))
      });
    let oraclizeQueryResponse // Used to store the oraclize query Response
    try {
      oraclizeQueryResponse = await promise() // Wait for the promise to resolve
    } catch (error) {
      console.error('\x1b[31m%s\x1b[0m', "Error sending the query: ", error)
      return shim.error(error)
    }
    const getRequestResult = () => // Create a promise to check for the result once available
      new Promise((res, rej) => {
        let counter = 0;
        const requestWrapper = async () => {
          const makeRequest = () =>
            new Promise((resolve, reject) =>
              request.get('https://api.oraclize.it/v1/contract/'
                + oraclizeQueryResponse.result.id
                + '/status?_pretty=1 ', (err, res, body) =>
                  err || res.statusCode != 200
                    ? reject(err)
                    : resolve(body)))
          counter++
          try {
            const body = await makeRequest()
            if (!JSON.parse(body).result.active) res(body)
            counter < 10
              ? setTimeout(requestWrapper, 2000)
              : rej('\x1b[31m%s\x1b[0m', 'Error: Over 20 seconds passed and too many attempts!')
          } catch (error) {
            counter = 10
              ? setTimeout(requestWrapper, 2000)
              : rej('\x1b[31m%s\x1b[0m', 'Error: Too many attempts! ', error)
          }
        }
        requestWrapper();
      })
    try {
      const oraclizeQueryResult = await getRequestResult() // Await for the result to return
      console.log("oraclizeQueryResult: ", oraclizeQueryResult);
      const jsonOraclizeQueryResult = JSON.parse(oraclizeQueryResult) // Create a JSON of the result
      console.log('\x1b[36m%s\x1b[0m', "Final response:")
      console.log(jsonOraclizeQueryResult)
      console.log('\x1b[35m%s\x1b[0m', '============= END : oraclizeQuery ===========')
      let result = jsonOraclizeQueryResult.result.checks[0].results[0] // Return only the results and the proofs
      let proof = jsonOraclizeQueryResult.result.checks[0].proofs[0].value
      if (typeof result === "string") {
        console.log("result typse is: string");
        result = Buffer.from(result)
      } else {
        console.log("result type is: ", typeof result);
        result = Buffer.from(result, 'hex')
      }
      if (typeof proof === "string") {
        console.log("proof type is: string");
        proof = Buffer.from(proof)
      } else {
        console.log("proof type is: ", typeof proof);
        proof = Buffer.from(result, 'hex')
      }
      var encodedBuffer = CBOR.encode([result, proof]);
      return Buffer.from(encodedBuffer) // Return the json created
    } catch (error) {
        console.error('\x1b[31m%s\x1b[0m', "Error in final response: ", error)
        const result = Buffer.from(null) // Return only the results and the proofs
        const proof = Buffer.from(null)
        var encodedBuffer = CBOR.encode([result, proof]);
        return Buffer.from(encodedBuffer)
    }
  }
};

shim.start(new Chaincode())
