const { MongoClient, ServerApiVersion } = require("mongodb");

const URI =
  "mongodb+srv://cyrusguest:4587DuckA@cluster0.6hjyr.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
  autoSelectFamily: false, // Explicitly disable auto selection of IP family
});

const setup = async () => {
  try {
    // Connect the client to the server
    await client.connect();
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } catch (err) {
    console.error(err);
  }
};

setup();

let db = client.db("pumpbot");

module.exports = db;
